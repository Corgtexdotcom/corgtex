import React from "react";

export function GoalWindowNotice({complete,nextHref,startHref,labels}:{
  complete:boolean;nextHref:string|null;startHref?:string;
  labels:{limited:string;next:string;start:string};
}) {
  if(complete&&!startHref)return null;
  return <aside className="nr-item stack" style={{padding:16,gap:12}} aria-label={labels.limited}>
    <p className="nr-item-meta" role="status">{labels.limited}</p>
    <div className="actions-inline">
      {nextHref&&<a className="secondary small" href={nextHref}>{labels.next}</a>}
      {startHref&&<a className="secondary small" href={startHref}>{labels.start}</a>}
    </div>
  </aside>;
}
