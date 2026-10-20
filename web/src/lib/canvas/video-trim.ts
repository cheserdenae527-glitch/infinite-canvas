import { withLocalProxy } from "@/stores/use-config-store";
import { videoTrimArgs, type VideoTrimRange } from "./video-trim-range";

export async function trimVideo(source: string, range: VideoTrimRange, signal?: AbortSignal): Promise<Blob> {
    const args = videoTrimArgs(range);
    signal?.throwIfAborted();
    const response = await fetch(withLocalProxy(source), { signal });
    if (!response.ok) throw new Error("无法读取源视频，请检查跨域权限或先导入本地视频");
    const input = new Uint8Array(await response.arrayBuffer());
    const [{ FFmpeg }, { default: coreURL }, { default: wasmURL }] = await Promise.all([import("@ffmpeg/ffmpeg"), import("@ffmpeg/core?url"), import("@ffmpeg/core/wasm?url")]);
    const ffmpeg = new FFmpeg();
    const abort = () => ffmpeg.terminate();
    signal?.addEventListener("abort", abort, { once: true });
    try {
        signal?.throwIfAborted();
        await ffmpeg.load({ coreURL, wasmURL });
        signal?.throwIfAborted();
        await ffmpeg.writeFile("input", input);
        if ((await ffmpeg.exec(args)) !== 0) throw new Error("视频裁剪失败，请检查源文件格式和起止时间");
        const output = await ffmpeg.readFile("output.mp4");
        signal?.throwIfAborted();
        if (typeof output === "string" || !output.byteLength) throw new Error("未生成有效视频");
        return new Blob([new Uint8Array(output)], { type: "video/mp4" });
    } finally {
        signal?.removeEventListener("abort", abort);
        ffmpeg.terminate();
    }
}
