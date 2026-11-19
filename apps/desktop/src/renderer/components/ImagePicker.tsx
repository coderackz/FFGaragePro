import { ImagePlus, Trash2 } from "lucide-react";
import { useRef } from "react";
import { toast } from "sonner";
import { Button } from "./ui";

const MAX_BYTES = 500 * 1024;
export const IMAGE_ERROR = "Use a PNG or JPG image under 500 KB";

/** Pick a PNG or JPG (≤ 500 KB) and hand it back as a data URL, or remove it. */
export function ImagePicker({ label, value, onChange, hint }: { label: string; value: string | null; onChange: (v: string | null) => void; hint?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const pick = (file: File | undefined) => {
    if (!file) return;
    if (!["image/png", "image/jpeg"].includes(file.type) || file.size > MAX_BYTES) return void toast.error(IMAGE_ERROR);
    const reader = new FileReader();
    reader.onload = () => onChange(String(reader.result));
    reader.onerror = () => toast.error("That image couldn't be read");
    reader.readAsDataURL(file);
  };
  return (
    <div className="rounded-lg border border-zinc-200 p-3">
      <div className="mb-2 text-sm font-medium text-zinc-900">{label}</div>
      <div className="flex h-20 items-center justify-center rounded-md bg-zinc-50 ring-1 ring-zinc-100 ring-inset">
        {value ? <img src={value} alt={label} className="max-h-16 max-w-[85%] object-contain" /> : <span className="text-xs text-zinc-500">{hint ?? "None"}</span>}
      </div>
      <div className="mt-2 flex gap-2">
        <Button size="sm" icon={<ImagePlus className="size-3.5" />} onClick={() => input.current?.click()}>{value ? "Replace" : "Upload"}</Button>
        {value && <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => onChange(null)} aria-label={`Remove ${label.toLowerCase()}`}>Remove</Button>}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        aria-label={`${label} file`}
        onChange={(e) => {
          pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}
