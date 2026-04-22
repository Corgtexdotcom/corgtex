import React from "react";

export function RecognitionCard({ recognition }: { recognition: any }) {
  const author = recognition.author?.user?.displayName || "Someone";
  const recipient = recognition.recipient?.user?.displayName || "Someone";
  
  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5 mb-4 shadow-sm">
      <div className="flex items-center text-sm text-gray-500 dark:text-gray-400 mb-3">
        <span className="font-medium text-gray-900 dark:text-white mr-1">{author}</span>
        <span>recognized</span>
        <span className="font-medium text-gray-900 dark:text-white ml-1">{recipient}</span>
      </div>
      <h4 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">{recognition.title}</h4>
      <div className="text-gray-700 dark:text-gray-300 leading-relaxed mb-4 whitespace-pre-wrap">
        {recognition.storyMd}
      </div>
      {recognition.valueTags && recognition.valueTags.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-4 pt-4 border-t border-gray-100 dark:border-gray-800">
          {recognition.valueTags.map((tag: string, idx: number) => (
            <span key={idx} className="px-2 py-1 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 text-xs rounded-full inline-block">
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
