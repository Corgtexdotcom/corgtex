"use client";

import { useState, useEffect, useRef } from "react";
import { X, Send, Sparkles, ArrowRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

interface Message {
  id: string;
  sender: "user" | "agent";
  text: string;
  timestamp: Date;
  status?: "sending" | "sent" | "streaming";
  structuredData?: {
    type: "table" | "stat-card" | "warning";
    title?: string;
    stats?: Array<{ label: string; value: string | number; tone?: string }>;
    columns?: string[];
    rows?: Array<Record<string, string | number>>;
  };
}

interface OpsAgentChatProps {
  isOpen: boolean;
  onClose: () => void;
  pageContext: {
    path: string;
    title: string;
    customerSlug?: string;
    customerLabel?: string;
  };
}

export function OpsAgentChat({ isOpen, onClose, pageContext }: OpsAgentChatProps) {
  const t = useTranslations("controlPlane");
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome",
      sender: "agent",
      text: "Hello! I am your Corgtex Ops Copilot. I have loaded your current workspace context and can help you run health checks, inspect releases, analyze budgets, or diagnose degraded agent deployments. What operations task can I assist you with today?",
      timestamp: new Date(),
    },
  ]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isTyping]);

  // Adjust starter questions depending on which page we are on
  const getStarters = () => {
    if (pageContext.customerLabel) {
      return [
        { label: `Check ${pageContext.customerLabel} Health`, query: `Run a full context and integration health snapshot sweep for ${pageContext.customerLabel}.` },
        { label: `Check feature flags`, query: `List all feature flag overrides currently applied to ${pageContext.customerLabel}.` },
        { label: `Examine agent budget`, query: `Analyze spending and model budget cap overrides for ${pageContext.customerLabel}.` },
      ];
    }
    return [
      { label: t("chat.starter1"), query: "Show me a summary of overall customer fleet health and release readiness." },
      { label: t("chat.starter2"), query: "Identify all degraded or attention-needed agents across the entire fleet." },
      { label: t("chat.starter3"), query: "Analyze model spend totals and list top spending deployments." },
    ];
  };

  const handleSend = async (textToSend: string) => {
    if (!textToSend.trim()) return;

    const userMsg: Message = {
      id: String(Date.now()),
      sender: "user",
      text: textToSend,
      timestamp: new Date(),
      status: "sent",
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsTyping(true);

    // Simulate AI thinking and streaming
    setTimeout(() => {
      setIsTyping(false);
      
      const replyText = `I received your query regarding "${textToSend}". Live ops-copilot execution is not connected in this panel yet, so I will not fabricate fleet telemetry. Use the visible control-plane tables on **${pageContext.title}** (${pageContext.path}) for current customer, release, agent, integration, and operation data.`;
      const structuredData: Message["structuredData"] = {
        type: "stat-card",
        title: "Live Copilot Not Connected",
        stats: [
          { label: "Response source", value: "UI context only", tone: "attention" },
          { label: "Production data", value: "Not queried by chat", tone: "attention" },
        ],
      };

      const agentMsg: Message = {
        id: String(Date.now() + 1),
        sender: "agent",
        text: replyText,
        timestamp: new Date(),
        structuredData,
      };

      setMessages((prev) => [...prev, agentMsg]);
    }, 1500);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md bg-[#0b0d13]/95 backdrop-blur-md border-l border-[#1f2430] shadow-2xl text-slate-100 transform transition-transform animate-in slide-in-from-right duration-300">
      
      {/* Container */}
      <div className="flex flex-col w-full h-full relative">
        
        {/* Header */}
        <div className="flex items-center justify-between px-4 h-16 border-b border-[#1f2430] bg-[#07090e]">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-brand-400 animate-pulse" />
            <div>
              <h2 className="text-sm font-semibold tracking-wide text-white">Ops Agent Copilot</h2>
              <p className="text-[10px] text-slate-400">Context: {pageContext.title}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-[#1a1f2c] border border-transparent hover:border-[#2d3548] text-slate-400 hover:text-white transition-all duration-150"
            aria-label="Close panel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Messages Area */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={cn(
                "flex flex-col max-w-[85%] space-y-1.5",
                msg.sender === "user" ? "ml-auto items-end" : "mr-auto items-start"
              )}
            >
              {/* Message bubble */}
              <div
                className={cn(
                  "p-3 rounded-xl text-xs leading-relaxed border",
                  msg.sender === "user"
                    ? "bg-brand-600 border-brand-500 text-white rounded-br-none"
                    : "bg-[#141822] border-[#202738] text-slate-200 rounded-bl-none"
                )}
              >
                {msg.text}
              </div>

              {/* Structured Reply Cards */}
              {msg.structuredData && (
                <div className="w-full bg-[#0a0d14] border border-[#202738] rounded-lg p-3 space-y-2.5 overflow-hidden animate-in fade-in duration-300">
                  <div className="flex items-center gap-1.5 border-b border-[#202738] pb-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-brand-400" />
                    <span className="text-[10px] font-bold tracking-wider uppercase text-slate-300">
                      {msg.structuredData.title || "Telemetry Report"}
                    </span>
                  </div>

                  {/* STAT CARDS LAYOUT */}
                  {msg.structuredData.type === "stat-card" && msg.structuredData.stats && (
                    <div className="grid grid-cols-2 gap-2">
                      {msg.structuredData.stats.map((stat, i) => (
                        <div key={i} className="bg-[#121622] border border-[#212739] rounded-lg p-2 flex flex-col">
                          <span className="text-[9px] text-slate-400 uppercase font-medium">{stat.label}</span>
                          <span className="text-xs font-bold text-white mt-0.5">{stat.value}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* TABLE LAYOUT */}
                  {msg.structuredData.type === "table" && msg.structuredData.columns && msg.structuredData.rows && (
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse text-[10px]">
                        <thead>
                          <tr className="border-b border-[#212739] text-left text-slate-400">
                            {msg.structuredData.columns.map((col, idx) => (
                              <th key={idx} className="p-1 pb-1.5 font-medium">{col}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {msg.structuredData.rows.map((row, rIdx) => {
                            const cols = msg.structuredData?.columns || [];
                            return (
                              <tr key={rIdx} className="border-b border-[#212739]/50 hover:bg-[#121622] text-slate-200">
                                {cols.map((col, cIdx) => (
                                  <td key={cIdx} className="p-1 py-1.5 font-medium">{row[col]}</td>
                                ))}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* Timestamp */}
              <span className="text-[9px] text-slate-500 px-1">
                {msg.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
          ))}

          {/* Typing Indicator */}
          {isTyping && (
            <div className="flex items-center gap-1 bg-[#141822] border border-[#202738] rounded-xl px-4 py-2.5 w-16 mr-auto rounded-bl-none">
              <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
              <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
              <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
            </div>
          )}
        </div>

        {/* Starters Carousel */}
        {messages.length === 1 && !isTyping && (
          <div className="px-4 py-2.5 bg-[#07090e]/60 border-t border-[#1f2430]/50 space-y-1.5 shrink-0">
            <span className="text-[9px] font-semibold text-slate-400 uppercase tracking-wider block mb-1">
              Suggested operations
            </span>
            <div className="flex flex-col gap-1.5">
              {getStarters().map((starter, i) => (
                <button
                  key={i}
                  onClick={() => handleSend(starter.query)}
                  className="flex items-center justify-between text-left text-[10px] w-full px-3 py-2 rounded-lg bg-[#141822] border border-[#202738] hover:border-[#2f3952] hover:bg-[#1a202d] text-slate-300 hover:text-white transition-all duration-150 group"
                >
                  <span className="truncate pr-2">{starter.label}</span>
                  <ArrowRight className="w-3.5 h-3.5 text-slate-500 group-hover:text-brand-400 shrink-0 transform group-hover:translate-x-0.5 transition-transform" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Input Panel */}
        <div className="p-4 border-t border-[#1f2430] bg-[#07090e] shrink-0">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSend(input);
            }}
            className="flex items-center gap-2 relative bg-[#141822] border border-[#202738] focus-within:border-[#2f3952] rounded-xl px-3 py-2 transition-all"
          >
            <input
              type="text"
              className="w-full bg-transparent border-0 ring-0 outline-none text-slate-200 placeholder-slate-500 text-xs focus:outline-none focus:ring-0"
              placeholder={t("chat.placeholder")}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={isTyping}
            />
            <button
              type="submit"
              disabled={!input.trim() || isTyping}
              className="p-1.5 rounded-lg bg-brand-600 text-white disabled:bg-[#1a1f2c] disabled:text-slate-600 transition-colors shrink-0"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          </form>
        </div>

      </div>
    </div>
  );
}
