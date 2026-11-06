export const integrationsCommand = (args, flags, ctx) => {
    const { out, print } = ctx;
    const { vault, cfg, index } = ctx.vault;
    const command = "integrations";
    const list = Object.values(cfg.integrations).map((i) => ({
        name: i.name,
        read: i.read ?? ["*"],
        write: i.write,
        views: i.views.map((v) => ({ kind: v.kind, path: v.path })),
        acting: cfg.as?.name === i.name,
    }));
    print(out, command, { integrations: list, as: cfg.as?.name ?? null }, { vault, index }, () => list.length
        ? list
            .map((i) => [
            `${i.acting ? "* " : ""}${i.name}`,
            `    read:  ${i.read.join(", ") || "(only its own log)"}`,
            `    write: ${i.write.join(", ") || "(nothing)"}`,
            ...(i.views.length ? i.views.map((v) => `    view:  ${v.kind} → ${v.path}`) : ["    view:  (none on this machine)"]),
        ].join("\n"))
            .join("\n")
        : 'no integrations yet — declare one under "integrations" in brain.json (see docs/integrations.md)');
    return 0;
};
