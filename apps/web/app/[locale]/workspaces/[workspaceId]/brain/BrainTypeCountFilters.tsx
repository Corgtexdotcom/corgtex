import React from "react";
import { boundedCountLabel } from "@/lib/bounded-count-label";

export function BrainTypeCountFilters({counts,complete,types,selectedType,href,labels}:{
  counts:Array<{type:string;count:number}>;complete:boolean;types:readonly string[];
  selectedType:string|null;href:(type:string|null)=>string;
  labels:{all:string;filter:string;limited:string};
}) {
  const displayed=complete?counts:types.map(type=>({type,count:counts.find(row=>row.type===type)?.count??0}));
  return <>
    {!complete && <p className="nr-item-meta" role="status">{labels.limited}</p>}
    <nav className="brain-filter-bar" aria-label={labels.filter}>
      <a className={`brain-filter-chip${selectedType?"":" active"}`} href={href(null)}><span>{labels.all}</span></a>
      {displayed.map(({type,count})=><a key={type} className={`brain-filter-chip${selectedType===type?" active":""}`} href={href(type)}>
        <span>{type}</span><strong>{boundedCountLabel({count,complete})}</strong>
      </a>)}
    </nav>
  </>;
}
