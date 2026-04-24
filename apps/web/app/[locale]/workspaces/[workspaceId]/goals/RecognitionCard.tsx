import React from"react";

export function RecognitionCard({ recognition }: { recognition: any }) {
 const author = recognition.author?.user?.displayName ||"Someone";
 const recipient = recognition.recipient?.user?.displayName ||"Someone";
 
 return (
 <div className="bg-surface-strong border border-line rounded-lg p-5 mb-4 shadow-sm">
 <div className="flex items-center text-sm text-muted mb-3">
 <span className="font-medium text-text mr-1">{author}</span>
 <span>recognized</span>
 <span className="font-medium text-text ml-1">{recipient}</span>
 </div>
 <h4 className="text-lg font-semibold text-text mb-2">{recognition.title}</h4>
 <div className="text-text leading-relaxed mb-4 whitespace-pre-wrap">
 {recognition.storyMd}
 </div>
 {recognition.valueTags && recognition.valueTags.length > 0 && (
 <div className="flex flex-wrap gap-2 mt-4 pt-4 border-t border-line-subtle">
 {recognition.valueTags.map((tag: string, idx: number) => (
 <span key={idx} className="px-2 py-1 bg-blue-50 text-blue-700 text-xs rounded-full inline-block">
 {tag}
 </span>
))}
 </div>
)}
 </div>
);
}
