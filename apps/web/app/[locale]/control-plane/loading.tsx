export default function ControlPlaneLoading() {
  return (
    <div className="space-y-5 pb-12">
      <div className="border-b border-line pb-5">
        <div className="h-3 w-32 animate-pulse rounded bg-surface" />
        <div className="mt-3 h-7 w-72 animate-pulse rounded bg-surface" />
        <div className="mt-3 h-4 w-full max-w-2xl animate-pulse rounded bg-surface" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {["customers", "deployments", "attention", "support", "release"].map((key) => (
          <div key={key} className="rounded-lg border border-line bg-bg-alt px-3 py-2">
            <div className="h-3 w-20 animate-pulse rounded bg-surface" />
            <div className="mt-3 h-6 w-12 animate-pulse rounded bg-surface" />
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-line bg-bg-alt p-4">
        <div className="mb-4 flex items-end justify-between gap-3 border-b border-line pb-3">
          <div>
            <div className="h-4 w-44 animate-pulse rounded bg-surface" />
            <div className="mt-2 h-3 w-72 animate-pulse rounded bg-surface" />
          </div>
          <div className="h-8 w-28 animate-pulse rounded bg-surface" />
        </div>
        <div className="space-y-3">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="grid grid-cols-10 gap-3 rounded-md border border-line bg-surface/40 p-3">
              {Array.from({ length: 10 }).map((__, cellIndex) => (
                <div key={cellIndex} className="h-5 animate-pulse rounded bg-surface" />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
