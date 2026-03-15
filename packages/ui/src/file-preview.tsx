interface FilePreviewProps {
  url: string;
  name: string;
  mimetype: string;
}

export default function FilePreview({ url, name, mimetype }: FilePreviewProps) {
  if (mimetype === "application/pdf") {
    return (
      <div className="file-pdf-preview">
        <div className="file-preview-label">{name}</div>
        <iframe
          src={url}
          title={name}
          style={{ width: "100%", height: "500px", border: "none" }}
          sandbox="allow-scripts allow-same-origin"
        />
      </div>
    );
  }

  if (mimetype.startsWith("audio/")) {
    return (
      <div className="file-audio-player">
        <div className="file-preview-label">{name}</div>
        <audio controls preload="metadata" style={{ width: "100%" }}>
          <source src={url} type={mimetype} />
          Your browser does not support audio playback.
        </audio>
      </div>
    );
  }

  if (mimetype.startsWith("video/")) {
    return (
      <div className="file-video-player">
        <div className="file-preview-label">{name}</div>
        <video controls preload="metadata" style={{ maxWidth: "100%", maxHeight: "400px" }}>
          <source src={url} type={mimetype} />
          Your browser does not support video playback.
        </video>
      </div>
    );
  }

  // Unknown previewable type — caller should gate with isPreviewableMimetype
  return null;
}

/**
 * Returns true if the mimetype has an inline preview (PDF, audio, video).
 * Images are excluded — handled by existing lightbox code in MessageList.
 */
export function isPreviewableMimetype(mimetype: string): boolean {
  return mimetype === "application/pdf" || mimetype.startsWith("audio/") || mimetype.startsWith("video/");
}
