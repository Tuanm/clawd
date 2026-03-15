// Shared ArtifactType and configuration — imported by artifact-card, artifact-modal, artifact-renderer.

export type ArtifactType = "html" | "react" | "svg" | "chart" | "csv" | "markdown" | "code";

export const TYPE_CONFIG: Record<ArtifactType, { label: string; icon: string; color: string }> = {
  html: { label: "HTML", icon: "</>", color: "hsl(15 80% 55%)" },
  react: { label: "React", icon: "R", color: "hsl(200 80% 55%)" },
  svg: { label: "SVG", icon: "S", color: "hsl(45 80% 50%)" },
  chart: { label: "Chart", icon: "C", color: "hsl(260 70% 60%)" },
  csv: { label: "CSV", icon: "T", color: "hsl(140 60% 45%)" },
  markdown: { label: "Markdown", icon: "M", color: "hsl(210 15% 55%)" },
  code: { label: "Code", icon: "{}", color: "hsl(180 50% 45%)" },
};

export const ARTIFACT_EXTENSION_MAP: Record<ArtifactType, string> = {
  html: ".html",
  react: ".jsx",
  svg: ".svg",
  chart: ".json",
  csv: ".csv",
  markdown: ".md",
  code: ".txt",
};
