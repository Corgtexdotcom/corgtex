"use client";

export function RecentUploads({ documents }: { documents: any[] }) {

  return (
    <section className="stack" style={{ marginTop: 40 }}>
      <h2 className="nr-section-header">Recent Uploads</h2>
      {documents.length === 0 ? (
         <p className="nr-item-meta">No recent documents uploaded.</p>
      ) : (
        <div>
          {documents.map(doc => (
            <div className="nr-item" key={doc.id} style={{ padding: "12px 16px", marginBottom: 8 }}>
              <div className="row" style={{ display: "flex", justifyContent: "space-between" }}>
                <strong className="nr-item-title">{doc.title}</strong>
              </div>
              <div className="nr-item-meta" style={{ marginTop: 4, fontSize: "0.85rem" }}>
                 <span className="tag">{doc.source}</span>
                 <span style={{ marginLeft: 8 }}>{new Date(doc.createdAt).toLocaleDateString()}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
