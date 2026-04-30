import { ImageResponse } from "next/og";
import { normalizeSiteLocale } from "../../i18n/routing";

export const contentType = "image/png";
export const size = {
  width: 1200,
  height: 630,
};

export default async function LocalizedOpenGraphImage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const isSpanish = normalizeSiteLocale(locale) === "es";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "56px 64px",
          background: "#1a1a1a",
          color: "#faf9f6",
          fontFamily: "Georgia, serif",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 20, letterSpacing: 4, textTransform: "uppercase", color: "#8a8a8a" }}>
            Corgtex
          </div>
          <div style={{ width: 60, height: 3, background: "#c41e1e" }} />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ fontSize: 56, fontWeight: 700, lineHeight: 1.1, maxWidth: 820 }}>
            {isSpanish
              ? "Dirige tu fuerza laboral de IA como un equipo responsable"
              : "Run Your AI Workforce Like an Accountable Team"}
          </div>
          <div style={{ fontSize: 22, color: "#8a8a8a", fontStyle: "italic", maxWidth: 660 }}>
            {isSpanish
              ? "Ve cada agente. Aplica tus reglas. Conoce el costo."
              : "See every agent. Enforce your rules. Know what it costs."}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderTop: "1px solid #333",
            paddingTop: 20,
          }}
        >
          <div style={{ fontSize: 14, color: "#666", letterSpacing: 2, textTransform: "uppercase" }}>
            corgtex.com
          </div>
          <div style={{ fontSize: 14, color: "#666" }}>
            {isSpanish ? "Fuerza laboral de IA gobernada" : "Governed AI Workforce"}
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
