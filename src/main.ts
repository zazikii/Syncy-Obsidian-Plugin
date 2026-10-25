import { Notice, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, mergePluginData, type PluginData, type SyncySettings } from "./data";

export default class SyncyPlugin extends Plugin {
  data: PluginData = mergePluginData(null);

  async onload(): Promise<void> {
    this.data = mergePluginData(await this.loadData());

    const statusBar = this.addStatusBarItem();
    statusBar.setText("Syncy: not configured");

    this.addRibbonIcon("refresh-cw", "Syncy: sync now", () => {
      new Notice("Syncy is not configured yet.");
    });
  }

  async saveSettings(patch: Partial<SyncySettings>): Promise<void> {
    this.data.settings = { ...DEFAULT_SETTINGS, ...this.data.settings, ...patch };
    await this.saveData(this.data);
  }
}
