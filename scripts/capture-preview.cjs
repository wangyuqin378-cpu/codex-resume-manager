const { app, BrowserWindow } = require("electron");
const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const outputPath = path.resolve(process.argv[2] || "artifacts/renderer-preview.png");
  const width = Number(process.argv[3] || 1100);
  const height = Number(process.argv[4] || 900);
  const window = new BrowserWindow({
    width,
    height,
    show: false,
    backgroundColor: "#eef2f5",
    webPreferences: {
      preload: path.join(__dirname, "preview-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  await window.webContents.executeJavaScript("document.fonts.ready");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const image = await window.webContents.capturePage();
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, image.toPNG());
  window.destroy();
  app.quit();
});
