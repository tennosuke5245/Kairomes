import { browser } from "./browser.ts";

void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
  console.error("無法開啟側欄，請確認瀏覽器支援 Side Panel API。");
});
