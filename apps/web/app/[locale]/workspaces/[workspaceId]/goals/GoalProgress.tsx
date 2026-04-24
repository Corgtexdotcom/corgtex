"use client";

import React from"react";

export function GoalProgress({ percent }: { percent: number }) {
 const p = Math.min(100, Math.max(0, percent));
 
 let colorClass ="bg-red-500";
 if (p >= 70) {
 colorClass ="bg-green-500";
 } else if (p >= 40) {
 colorClass ="bg-yellow-500";
 }

 return (
 <div className="w-full h-2 bg-accent-soft rounded-full overflow-hidden mt-1 relative">
 <div 
 className={`h-full rounded-full transition-all duration-500 ease-in-out ${colorClass}`}
 style={{ width: `${p}%` }}
 />
 </div>
);
}
