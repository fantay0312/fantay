import { cac } from "cac";

const cli = cac("tools-release");

cli.command('next-version', 'Print the next Fantay calendar version without modifying files')
  .option('--date <date>', 'Release date in Asia/Taipei (YYYY-MM-DD)')
  .action(async (options: { date?: string }) => {
    const { FANTAY_RELEASES } = await import('@open-design/contracts');
    const { nextFantayVersion } = await import('@open-design/release');
    console.log(nextFantayVersion(FANTAY_RELEASES.map(r => r.version), options.date));
  });

cli.command('sync-version', 'Synchronize app versions, detailed changelogs and website data')
  .option('--check', 'Check without changing files')
  .action(async (options: { check?: boolean }) => {
    const { syncFantayVersion } = await import('./fantay-version.js');
    const changed = await syncFantayVersion(options.check);
    console.log(options.check ? 'Version and release records are consistent.' : `Synchronized ${changed.length} files.`);
  });

cli
  .command("publish-dsh-bootstrap", "Publish immutable DeepSeek Harness bootstrap installers")
  .action(async () => {
    await import("./storage/publish-dsh-bootstrap.ts");
  });

cli
  .command("export-catalog", "Export product content into a catalog.json snapshot staging dir")
  .action(async () => {
    const { exportCatalogFromEnv } = await import("./catalog/export-catalog.ts");
    await exportCatalogFromEnv();
  });

cli
  .command("render-catalog-previews", "Render catalog preview webp images into the staging dir")
  .action(async () => {
    const { renderCatalogPreviewsFromEnv } = await import("./catalog/render-catalog-previews.ts");
    await renderCatalogPreviewsFromEnv();
  });

cli
  .command("pack-catalog", "Write checksums, provenance, and bundle.tar.zst for a catalog snapshot")
  .action(async () => {
    const { packCatalogFromEnv } = await import("./catalog/pack-catalog.ts");
    await packCatalogFromEnv();
  });

cli
  .command("publish-catalog", "Publish an immutable catalog snapshot and update latest.json")
  .action(async () => {
    const { publishCatalogFromEnv } = await import("./storage/publish-catalog.ts");
    await publishCatalogFromEnv();
  });

cli.help();
cli.parse();
