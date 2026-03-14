import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ATTACHMENTS_DIR, db, generateId } from "../database";

// Cache directory for optimized images
const OPTIMIZED_CACHE_DIR = join(ATTACHMENTS_DIR, ".optimized");

export interface FileRecord {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  path: string;
  message_ts: string | null;
  uploaded_by: string;
  created_at: number;
  public: number; // 0 = private (default), 1 = publicly accessible
}

// POST /api/files.upload
export async function uploadFile(file: File, _channel: string, _threadTs?: string, userId = "UHUMAN") {
  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
  if (file.size > MAX_FILE_SIZE) {
    return { ok: false, error: "File too large. Maximum file size is 10MB." };
  }

  const id = generateId("F");
  const ext = file.name.split(".").pop() || "";
  const filename = `${id}.${ext}`;
  const filepath = join(ATTACHMENTS_DIR, filename);

  // Save file to disk
  const buffer = await file.arrayBuffer();
  writeFileSync(filepath, Buffer.from(buffer));

  // Insert file record
  db.run(`INSERT INTO files (id, name, mimetype, size, path, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)`, [
    id,
    file.name,
    file.type,
    file.size,
    filepath,
    userId,
  ]);

  const fileInfo = {
    id,
    name: file.name,
    mimetype: file.type,
    size: file.size,
    url_private: `/api/files/${id}`,
  };

  return {
    ok: true,
    file: fileInfo,
  };
}

// GET /api/files/:id
export function getFile(id: string) {
  const file = db.query<FileRecord, [string]>(`SELECT * FROM files WHERE id = ?`).get(id);

  if (!file || !existsSync(file.path)) {
    return null;
  }

  return {
    data: readFileSync(file.path),
    mimetype: file.mimetype,
    name: file.name,
  };
}

// Attach files to a message
export function attachFilesToMessage(messageTs: string, fileIds: string[]) {
  const files: { id: string; name: string; mimetype: string; size: number; url_private: string }[] = [];

  for (const id of fileIds) {
    const file = db.query<FileRecord, [string]>(`SELECT * FROM files WHERE id = ?`).get(id);

    if (file) {
      db.run(`UPDATE files SET message_ts = ? WHERE id = ?`, [messageTs, id]);
      files.push({
        id: file.id,
        name: file.name,
        mimetype: file.mimetype,
        size: file.size,
        url_private: `/api/files/${file.id}`,
      });
    }
  }

  // Update message with files
  db.run(`UPDATE messages SET files_json = ? WHERE ts = ?`, [JSON.stringify(files), messageTs]);

  return files;
}

// Check if mimetype is an image that can be optimized
function isOptimizableImage(mimetype: string): boolean {
  return ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mimetype);
}

// Optimize image using ImageMagick convert command (fallback when sharp unavailable)
async function optimizeWithImageMagick(
  inputPath: string,
  outputPath: string,
  maxWidth: number,
  maxHeight: number,
  quality: number,
  maxBytes: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    // ImageMagick convert command:
    // -resize WxH> : resize only if larger (maintains aspect ratio)
    // -quality N : JPEG quality
    // -strip : remove metadata
    // -define jpeg:extent=NKB : target file size (approximate)
    const targetKB = Math.floor(maxBytes / 1024);
    const args = [
      inputPath,
      "-resize",
      `${maxWidth}x${maxHeight}>`,
      "-quality",
      String(quality),
      "-strip",
      "-define",
      `jpeg:extent=${targetKB}KB`,
      outputPath,
    ];

    const proc = spawn("convert", args);

    proc.on("close", (code) => {
      resolve(code === 0);
    });

    proc.on("error", (err) => {
      console.warn("[optimizeWithImageMagick] convert not available:", err.message);
      resolve(false);
    });
  });
}

// Optimize image using macOS sips command (fallback for Mac)
async function optimizeWithSips(
  inputPath: string,
  outputPath: string,
  maxWidth: number,
  maxHeight: number,
  _quality: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    // sips is macOS only - resize to fit within dimensions
    // First copy the file, then resize in place
    const { copyFileSync } = require("fs");
    try {
      copyFileSync(inputPath, outputPath);
    } catch {
      resolve(false);
      return;
    }

    const args = ["--resampleHeightWidthMax", String(Math.max(maxWidth, maxHeight)), outputPath];

    const proc = spawn("sips", args);

    proc.on("close", (code) => {
      resolve(code === 0);
    });

    proc.on("error", (err) => {
      console.warn("[optimizeWithSips] sips not available:", err.message);
      resolve(false);
    });
  });
}

// GET /api/files/:id/optimized - Optimized image for agents
// Options:
//   - maxWidth: max width in pixels (default: 1280)
//   - maxHeight: max height in pixels (default: 720)
//   - quality: JPEG quality 1-100 (default: 70)
//   - maxBytes: target max file size in bytes (default: 100KB)
export async function getOptimizedFile(
  id: string,
  options: { maxWidth?: number; maxHeight?: number; quality?: number; maxBytes?: number } = {},
): Promise<{ data: Buffer; mimetype: string; name: string; originalSize: number; optimizedSize: number } | null> {
  const file = db.query<FileRecord, [string]>(`SELECT * FROM files WHERE id = ?`).get(id);

  if (!file || !existsSync(file.path)) {
    return null;
  }

  // If not an optimizable image, return original
  if (!isOptimizableImage(file.mimetype)) {
    const data = readFileSync(file.path);
    return {
      data,
      mimetype: file.mimetype,
      name: file.name,
      originalSize: file.size,
      optimizedSize: data.length,
    };
  }

  const { maxWidth = 1280, maxHeight = 720, quality = 70, maxBytes = 100 * 1024 } = options;

  // Generate cache key based on options
  const cacheKey = `${id}_${maxWidth}x${maxHeight}_q${quality}_b${maxBytes}`;
  const cacheExt = "jpg"; // Always output JPEG for best compression
  const cachePath = join(OPTIMIZED_CACHE_DIR, `${cacheKey}.${cacheExt}`);

  // Check cache first
  if (existsSync(cachePath)) {
    const cachedData = readFileSync(cachePath);
    return {
      data: cachedData,
      mimetype: "image/jpeg",
      name: file.name.replace(/\.[^.]+$/, ".jpg"),
      originalSize: file.size,
      optimizedSize: cachedData.length,
    };
  }

  // Use sharp for optimization if available
  try {
    const sharp = await import("sharp");
    const originalData = readFileSync(file.path);

    // Get image metadata
    const metadata = await sharp.default(originalData).metadata();

    // Calculate resize dimensions maintaining aspect ratio
    let width = metadata.width || maxWidth;
    let height = metadata.height || maxHeight;

    if (width > maxWidth || height > maxHeight) {
      const aspectRatio = width / height;
      if (width / maxWidth > height / maxHeight) {
        width = maxWidth;
        height = Math.round(maxWidth / aspectRatio);
      } else {
        height = maxHeight;
        width = Math.round(maxHeight * aspectRatio);
      }
    }

    // Optimize image - start with requested quality and reduce if needed
    let currentQuality = quality;
    let optimizedData: Buffer;

    do {
      optimizedData = await sharp
        .default(originalData)
        .resize(width, height, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: currentQuality, mozjpeg: true })
        .toBuffer();

      // If still too large, reduce quality
      if (optimizedData.length > maxBytes && currentQuality > 20) {
        currentQuality -= 10;
      } else {
        break;
      }
    } while (currentQuality >= 20);

    // Ensure cache directory exists
    if (!existsSync(OPTIMIZED_CACHE_DIR)) {
      mkdirSync(OPTIMIZED_CACHE_DIR, { recursive: true });
    }

    // Save to cache
    writeFileSync(cachePath, optimizedData);

    return {
      data: optimizedData,
      mimetype: "image/jpeg",
      name: file.name.replace(/\.[^.]+$/, ".jpg"),
      originalSize: file.size,
      optimizedSize: optimizedData.length,
    };
  } catch (error) {
    // Sharp not available - try ImageMagick or sips as fallback
    console.warn("[getOptimizedFile] Sharp not available, trying ImageMagick...");

    // Ensure cache directory exists
    if (!existsSync(OPTIMIZED_CACHE_DIR)) {
      mkdirSync(OPTIMIZED_CACHE_DIR, { recursive: true });
    }

    // Try ImageMagick convert first (Linux/Mac)
    let success = await optimizeWithImageMagick(file.path, cachePath, maxWidth, maxHeight, quality, maxBytes);

    // Try sips on macOS if convert failed
    if (!success) {
      console.warn("[getOptimizedFile] ImageMagick not available, trying sips...");
      success = await optimizeWithSips(file.path, cachePath, maxWidth, maxHeight, quality);
    }

    // If either succeeded, read the optimized file
    if (success && existsSync(cachePath)) {
      const optimizedData = readFileSync(cachePath);
      console.log(`[getOptimizedFile] Optimized with system tool: ${file.size} -> ${optimizedData.length} bytes`);
      return {
        data: optimizedData,
        mimetype: "image/jpeg",
        name: file.name.replace(/\.[^.]+$/, ".jpg"),
        originalSize: file.size,
        optimizedSize: optimizedData.length,
      };
    }

    // All optimization methods failed - return original
    console.warn("[getOptimizedFile] No optimization tools available, returning original");
    const data = readFileSync(file.path);
    return {
      data,
      mimetype: file.mimetype,
      name: file.name,
      originalSize: file.size,
      optimizedSize: data.length,
    };
  }
}

// Get file metadata without content (for lazy loading decisions)
export function getFileMetadata(id: string): {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  isImage: boolean;
  canOptimize: boolean;
} | null {
  const file = db.query<FileRecord, [string]>(`SELECT * FROM files WHERE id = ?`).get(id);

  if (!file) {
    return null;
  }

  return {
    id: file.id,
    name: file.name,
    mimetype: file.mimetype,
    size: file.size,
    isImage: file.mimetype.startsWith("image/"),
    canOptimize: isOptimizableImage(file.mimetype),
  };
}

// POST /api/files/:id/visibility — toggle public access
export function setFileVisibility(id: string, visible: boolean): { ok: boolean; error?: string; public_url?: string } {
  const file = db.query<FileRecord, [string]>(`SELECT * FROM files WHERE id = ?`).get(id);
  if (!file) return { ok: false, error: "file_not_found" };

  db.run(`UPDATE files SET public = ? WHERE id = ?`, [visible ? 1 : 0, id]);

  return {
    ok: true,
    ...(visible ? { public_url: `/api/public/files/${id}` } : {}),
  };
}

// GET /api/public/files/:id — serve file without auth (only if marked public)
export function getPublicFile(id: string) {
  const file = db.query<FileRecord, [string]>(`SELECT * FROM files WHERE id = ? AND public = 1`).get(id);

  if (!file || !existsSync(file.path)) {
    return null;
  }

  return {
    data: readFileSync(file.path),
    mimetype: file.mimetype,
    name: file.name,
  };
}
