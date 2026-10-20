import { expect, test } from "bun:test";

if (typeof globalThis.localStorage === "undefined") {
    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    });
}

const [{ defaultConfig, encodeChannelModel }, { requestGeneration }, { createVideoGenerationTask, pollVideoGenerationTask }] = await Promise.all([
    import("../src/stores/use-config-store"),
    import("../src/services/api/image"),
    import("../src/services/api/video"),
]);

function channelConfig(capability: "image" | "video", model: string, apiKey: string, baseUrl: string) {
    const channelId = `${capability}-channel`;
    const selection = encodeChannelModel(channelId, model);
    return {
        ...defaultConfig,
        channels: [{ id: channelId, name: "Mock provider", baseUrl, apiKey, apiFormat: "openai" as const, models: [{ name: model, capability }] }],
        models: [selection],
        model: selection,
        imageModel: capability === "image" ? selection : defaultConfig.imageModel,
        videoModel: capability === "video" ? selection : defaultConfig.videoModel,
    };
}

test("image generation uses the selected channel credentials, model, and response", async () => {
    let received: { path: string; authorization: string | null; body: Record<string, unknown> } | undefined;
    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
            received = {
                path: new URL(request.url).pathname,
                authorization: request.headers.get("authorization"),
                body: (await request.json()) as Record<string, unknown>,
            };
            return Response.json({ data: [{ b64_json: "AA==" }] });
        },
    });

    try {
        const result = await requestGeneration(channelConfig("image", "mock-image-model", "test-image-key", server.url.origin), "integration prompt");

        expect(received).toEqual({
            path: "/v1/images/generations",
            authorization: "Bearer test-image-key",
            body: expect.objectContaining({ model: "mock-image-model", prompt: "integration prompt" }),
        });
        expect(result).toHaveLength(1);
        expect(result[0]?.dataUrl).toBe("data:image/png;base64,AA==");
    } finally {
        server.stop();
    }
});

test("video generation uses the selected channel through task creation and polling", async () => {
    const requests: Array<{ path: string; authorization: string | null; model?: string; prompt?: string }> = [];
    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
            const path = new URL(request.url).pathname;
            const authorization = request.headers.get("authorization");
            if (request.method === "POST" && path === "/v1/videos") {
                const form = await request.formData();
                requests.push({ path, authorization, model: String(form.get("model")), prompt: String(form.get("prompt")) });
                return Response.json({ id: "mock-video-task" });
            }
            requests.push({ path, authorization });
            if (path === "/v1/videos/mock-video-task") return Response.json({ id: "mock-video-task", status: "in_progress" });
            return Response.json({ error: { message: "unexpected mock API route" } }, { status: 404 });
        },
    });

    try {
        const config = channelConfig("video", "mock-video-model", "test-video-key", server.url.origin);
        const task = await createVideoGenerationTask(config, "integration video prompt");
        const state = await pollVideoGenerationTask(config, task);

        expect(requests).toEqual([
            { path: "/v1/videos", authorization: "Bearer test-video-key", model: "mock-video-model", prompt: "integration video prompt" },
            { path: "/v1/videos/mock-video-task", authorization: "Bearer test-video-key" },
        ]);
        expect(task).toEqual({ id: "mock-video-task", provider: "openai", model: "video-channel::mock-video-model" });
        expect(state).toEqual({ status: "pending" });
    } finally {
        server.stop();
    }
});
