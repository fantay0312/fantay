(async function () {
  const targets = ['https://static.tokentosea.com/fantay-design/releases/stable/latest/metadata.json', 'https://github.com/fantay0312/fantay/releases/latest/download/metadata.json'];
  for (const target of targets) {
    try {
      const response = await fetch(target, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) continue;
      const metadata = await response.json();
      if (metadata.channel !== 'stable' || !metadata.releaseVersion) continue;
      const container = document.getElementById('release-downloads');
      const links = [];
      for (const [platform, label, kind] of [['mac','macOS Apple Silicon','dmg'],['macIntel','macOS Intel','dmg'],['win','Windows x64','installer'],['linux','Linux x64','appImage']]) {
        const entry = metadata.platforms?.[platform];
        const asset = entry?.artifacts?.[kind];
        if (entry?.enabled !== true || !asset?.url) continue;
        const url = new URL(asset.url);
        if (url.protocol !== 'https:' || !['static.tokentosea.com','github.com'].includes(url.hostname)) continue;
        const link = document.createElement('a');
        link.href = url.href; link.textContent = label + ' · ' + metadata.releaseVersion + ' ↓'; links.push(link);
      }
      if (!links.length) continue;
      container.replaceChildren(...links); container.className = 'downloads'; break;
    } catch { /* Keep the honest unpublished state while both feeds are absent. */ }
  }
})();
