export type VideoTrimRange = { start: number; end: number };

export function videoTrimArgs({ start, end }: VideoTrimRange): string[] {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
        throw new Error("起止时间必须是有效秒数，且结束时间必须大于开始时间");
    }
    // Output seeking decodes up to the requested start instead of copying an earlier keyframe.
    return [
        "-i",
        "input",
        "-ss",
        String(start),
        "-t",
        String(end - start),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-vf",
        "pad=ceil(iw/2)*2:ceil(ih/2)*2",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        "output.mp4",
    ];
}
