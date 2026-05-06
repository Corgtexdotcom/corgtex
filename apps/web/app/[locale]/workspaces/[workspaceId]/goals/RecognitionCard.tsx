import React from"react";
import { useTranslations } from "next-intl";
import { MarkdownRenderer } from "@/lib/components/MarkdownRenderer";

export function RecognitionCard({ recognition }: { recognition: any }) {
 const t = useTranslations("goals");
 const author = recognition.author?.user?.displayName || t("someone");
 const recipient = recognition.recipient?.user?.displayName || t("someone");
 
 return (
 <div className="bg-surface-strong border border-line rounded-lg p-5 mb-4 shadow-sm">
 <div className="flex items-center text-sm text-muted mb-3">
 <span className="font-medium text-text mr-1">{author}</span>
 <span>{t("recognized")}</span>
 <span className="font-medium text-text ml-1">{recipient}</span>
 </div>
 <h4 className="text-lg font-semibold text-text mb-2">{recognition.title}</h4>
 <MarkdownRenderer markdown={recognition.storyMd} variant="compact" className="text-text mb-4" />
 {recognition.valueTags && recognition.valueTags.length > 0 && (
 <div className="flex flex-wrap gap-2 mt-4 pt-4 border-t border-line-subtle">
 {recognition.valueTags.map((tag: string, idx: number) => (
 <span key={idx} className="px-2 py-1 bg-info-soft text-info text-xs rounded-full inline-block">
 {tag}
 </span>
))}
 </div>
)}
 </div>
);
}
