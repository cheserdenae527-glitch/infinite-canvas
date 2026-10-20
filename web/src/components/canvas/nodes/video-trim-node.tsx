import { useEffect, useRef, useState } from "react";
import { Download, Scissors, X } from "lucide-react";
import { nanoid } from "nanoid";

import { videoMetadata } from "@/lib/canvas/canvas-node-factory";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { trimVideo } from "@/lib/canvas/video-trim";
import { deleteStoredMedia, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { CanvasNodeContext, CanvasNodeDefinition } from "@/types/canvas-plugin";

function videoInputs(nodes: CanvasNodeData[]) {
    return nodes.flatMap((node) => {
        const resource = getNodeDefinition(node.type)?.resource?.(node);
        return resource?.kind === "video" && resource.url ? [{ node, url: resource.url, key: `${node.id}\n${resource.url}` }] : [];
    });
}

function VideoTrimContent({ ctx }: { ctx: CanvasNodeContext }) {
    const [inputs, setInputs] = useState(() => videoInputs(ctx.getUpstream()));
    // The host updates graph refs in its layout effect, after this node renders.
    useEffect(() => {
        const next = videoInputs(ctx.getUpstream());
        setInputs((previous) => (previous.length === next.length && previous.every((input, index) => input.key === next[index].key && input.node === next[index].node) ? previous : next));
    });
    const source = inputs.length === 1 ? inputs[0] : null;
    const sourceKey = source?.key || "";
    const current = useRef(ctx);
    current.current = ctx;
    const mounted = useRef(false);
    const job = useRef<AbortController | null>(null);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState("");
    const [start, setStart] = useState(String(ctx.node.metadata?.trimStart ?? 0));
    const [end, setEnd] = useState(ctx.node.metadata?.trimEnd === undefined ? "" : String(ctx.node.metadata.trimEnd));
    const [duration, setDuration] = useState<{ key: string; seconds: number } | null>(null);
    useEffect(() => {
        setStart(String(ctx.node.metadata?.trimStart ?? 0));
        setEnd(ctx.node.metadata?.trimEnd === undefined ? "" : String(ctx.node.metadata.trimEnd));
    }, [ctx.node.metadata?.trimStart, ctx.node.metadata?.trimEnd]);
    const seconds = duration?.key === sourceKey ? duration.seconds : undefined;
    const range = { start: Number(start), end: Number(end) };
    const rangeValid = Boolean(source && seconds !== undefined && start !== "" && end !== "" && Number.isFinite(range.start) && Number.isFinite(range.end) && range.start >= 0 && range.end > range.start && range.end <= seconds);

    useEffect(() => {
        setNotice("");
        return () => job.current?.abort();
    }, [sourceKey]);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            job.current?.abort();
        };
    }, []);

    const cancel = () => {
        job.current?.abort();
        setNotice("已取消导出");
    };

    const exportClip = async () => {
        if (!source || !rangeValid || job.current) return;
        const controller = new AbortController();
        job.current = controller;
        setBusy(true);
        setNotice("正在导出 MP4…");
        let saved: UploadedFile | undefined;
        let published = false;
        const stillCurrent = () => {
            const latest = current.current;
            const sources = videoInputs(latest.getUpstream());
            return !controller.signal.aborted && Boolean(latest.getNode(ctx.node.id)) && sources.length === 1 && sources[0].key === source.key;
        };
        try {
            const blob = await trimVideo(source.url, range, controller.signal);
            if (!stillCurrent()) return;
            saved = await uploadMediaFile(blob, "video");
            if (!stillCurrent()) return;
            const latest = current.current;
            const id = `video-${nanoid()}`;
            const size = fitNodeSize(saved.width || 1280, saved.height || 720, 640, 360);
            latest.applyOps([
                {
                    type: "add_node",
                    id,
                    nodeType: CanvasNodeType.Video,
                    title: `${source.node.title} · ${range.start}–${range.end} 秒`,
                    position: { x: latest.node.position.x + latest.node.width + 60, y: latest.node.position.y },
                    ...size,
                    metadata: videoMetadata(saved),
                },
                { type: "connect_nodes", fromNodeId: latest.node.id, toNodeId: id },
                { type: "select_nodes", ids: [id] },
            ]);
            published = true;
            setNotice("已在右侧创建视频，可播放或下载");
        } catch (error) {
            if (stillCurrent()) setNotice(error instanceof Error ? error.message : "导出失败，请重试");
        } finally {
            if (saved && !published) await deleteStoredMedia([saved.storageKey]);
            if (job.current === controller) {
                job.current = null;
                if (mounted.current) setBusy(false);
            }
        }
    };

    const fieldStyle = { width: "100%", minWidth: 0, padding: "6px 8px", border: `1px solid ${ctx.theme.node.stroke}`, borderRadius: 6, background: "transparent", color: ctx.theme.node.text };
    const buttonClass = "flex items-center justify-center gap-1.5 rounded px-3 py-2 text-xs hover:bg-black/5 dark:hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40";

    return (
        <div
            data-canvas-no-zoom
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            className="flex h-full w-full flex-col gap-3 overflow-auto p-4 text-xs"
            style={{ color: ctx.theme.node.text }}
        >
            <div className="flex items-center gap-2 text-sm font-medium">
                <Scissors className="size-4" />
                视频截取
            </div>
            {source ? (
                <>
                    <div className="truncate" title={source.node.title} style={{ color: ctx.theme.node.muted }}>
                        {source.node.title}
                    </div>
                    <video
                        key={sourceKey}
                        src={source.url}
                        controls
                        preload="metadata"
                        className="h-32 w-full shrink-0 rounded object-contain"
                        onLoadedMetadata={(event) => {
                            const value = event.currentTarget.duration;
                            if (!Number.isFinite(value) || value <= 0) {
                                setNotice("无法读取有效的视频时长");
                                return;
                            }
                            setDuration({ key: sourceKey, seconds: value });
                            setNotice("");
                            if (end === "") {
                                setEnd(String(value));
                                current.current.updateMetadata({ trimEnd: value });
                            }
                        }}
                        onError={() => {
                            setDuration(null);
                            setNotice("无法读取视频，请检查来源");
                        }}
                    />
                    <div style={{ color: ctx.theme.node.muted }}>{seconds === undefined ? "正在读取时长…" : `原视频 ${seconds.toFixed(3)} 秒`}</div>
                </>
            ) : (
                <div className="py-6 leading-6" style={{ color: ctx.theme.node.placeholder }}>
                    {inputs.length > 1 ? "请只连接一个视频输入" : "将视频节点连接到左侧，再设置截取时间"}
                </div>
            )}
            <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1.5">
                    开始（秒）
                    <input
                        aria-label="开始（秒）"
                        type="number"
                        min={0}
                        step="any"
                        value={start}
                        disabled={busy}
                        style={fieldStyle}
                        onChange={(event) => {
                            setStart(event.target.value);
                            if (event.target.value !== "" && Number.isFinite(event.target.valueAsNumber)) ctx.updateMetadata({ trimStart: event.target.valueAsNumber });
                        }}
                    />
                </label>
                <label className="flex flex-col gap-1.5">
                    结束（秒）
                    <input
                        aria-label="结束（秒）"
                        type="number"
                        min={0}
                        max={seconds}
                        step="any"
                        value={end}
                        disabled={busy}
                        style={fieldStyle}
                        onChange={(event) => {
                            setEnd(event.target.value);
                            if (event.target.value !== "" && Number.isFinite(event.target.valueAsNumber)) ctx.updateMetadata({ trimEnd: event.target.valueAsNumber });
                        }}
                    />
                </label>
            </div>
            {source && seconds !== undefined && !rangeValid ? (
                <div role="alert" className="leading-5">
                    请输入有效范围：0 ≤ 开始 &lt; 结束 ≤ 视频时长
                </div>
            ) : null}
            <div className="flex items-center gap-1">
                <button type="button" className={buttonClass} disabled={!rangeValid || busy} onClick={() => void exportClip()}>
                    <Download className="size-3.5" />
                    {busy ? "导出中…" : "导出片段"}
                </button>
                {busy ? (
                    <button type="button" className={buttonClass} onClick={cancel}>
                        <X className="size-3.5" />
                        取消
                    </button>
                ) : null}
            </div>
            <div role="status" aria-live="polite" className="min-h-4 leading-5" style={{ color: ctx.theme.node.muted }}>
                {notice}
            </div>
        </div>
    );
}

export const videoTrimNodeDefinition: CanvasNodeDefinition = {
    type: "builtin:video-trim",
    title: "视频截取",
    icon: <Scissors className="size-5" />,
    description: "连接视频并导出指定时间范围的 MP4 片段",
    defaultSize: { width: 360, height: 430 },
    defaultMetadata: { trimStart: 0 },
    minimapColor: "#f97316",
    hasSourceHandle: false,
    hidePanel: true,
    Content: VideoTrimContent,
};
