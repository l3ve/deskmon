import { getCurrentWindow } from "@tauri-apps/api/window";
import { mountPet } from "./pet";
import { mountRemember } from "./remember";
import { mountSettings } from "./settings";

const root = document.querySelector<HTMLElement>("#app");

if (!root) {
  throw new Error("Deskmon root element is missing");
}

const currentWindow = getCurrentWindow();
const route = window.location.hash.replace("#", "") || currentWindow.label;

if (route === "settings") {
  mountSettings(root);
} else if (route === "remember") {
  mountRemember(root);
} else {
  mountPet(root);
}
