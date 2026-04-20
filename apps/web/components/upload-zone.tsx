"use client";

import { useState, useRef, useCallback } from "react";
import { Upload, Link, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { useRouter } from "next/navigation";

export function UploadZone() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [subtitles, setSubtitles] = useState(true);
  const [subtitlePreset, setSubtitlePreset] = useState("tiktok");
  const [loading, setLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile?.type.startsWith("video/")) {
      setFile(droppedFile);
      setUrl("");
    }
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) {
      setFile(selected);
      setUrl("");
    }
  };

  const handleSubmit = async () => {
    if (!file && !url.trim()) return;
    setLoading(true);
    setError(null);
    setUploadProgress(null);

    try {
      let sourceKey: string | undefined;
      let originalFilename: string | undefined;

      if (file) {
        // Step 1: Get presigned upload URL
        setUploadProgress("Getting upload URL...");
        const { uploadUrl, key } = await api.uploads.getPresignedUrl(
          file.name,
          file.type || "video/mp4"
        );
        sourceKey = key;
        originalFilename = file.name;

        // Step 2: Upload directly to R2
        setUploadProgress("Uploading video...");
        const uploadRes = await fetch(uploadUrl, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type || "video/mp4" },
        });

        if (!uploadRes.ok) {
          throw new Error("Failed to upload file");
        }
        setUploadProgress("Creating job...");
      }

      // Step 3: Create job
      const job = await api.jobs.create({
        url: url.trim() || undefined,
        sourceKey,
        originalFilename,
        subtitles,
        subtitlePreset,
      });

      router.push(`/dashboard/jobs/${job.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
      setUploadProgress(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* Drop zone */}
      <div
        className={cn(
          "relative flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors",
          dragActive
            ? "border-primary bg-accent/50"
            : "border-border hover:border-muted-foreground/50"
        )}
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
      >
        <Upload className="mb-3 h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          {file ? (
            <span className="text-foreground font-medium">{file.name}</span>
          ) : (
            "Drop a video file here"
          )}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => fileInputRef.current?.click()}
        >
          Choose file
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={handleFileSelect}
        />
      </div>

      {/* URL input */}
      <div className="flex items-center gap-2">
        <Link className="h-4 w-4 text-muted-foreground shrink-0" />
        <Input
          placeholder="Or paste a video URL (YouTube, TikTok, Twitch)"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            if (e.target.value) setFile(null);
          }}
        />
      </div>

      {/* Options */}
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={subtitles}
            onCheckedChange={(v) => setSubtitles(v === true)}
          />
          Subtitles
        </label>
        {subtitles && (
          <Select value={subtitlePreset} onValueChange={setSubtitlePreset}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tiktok">TikTok Style</SelectItem>
              <SelectItem value="minimal">Minimal</SelectItem>
              <SelectItem value="bold">Bold</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Submit */}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button
        onClick={handleSubmit}
        disabled={loading || (!file && !url.trim())}
        className="w-full"
      >
        {loading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {uploadProgress || "Processing..."}
          </>
        ) : (
          "Process Video"
        )}
      </Button>
    </div>
  );
}
