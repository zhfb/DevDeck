// i18n 中英双语（P2）— i18next + react-i18next
// 应用外壳（导航、面板标题、通用词）走 t() 文案；面板内长文本逐步迁移。
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zh from "./locales/zh.json";
import en from "./locales/en.json";

export const SUPPORTED_LANGUAGES = [
  { code: "zh", label: "简体中文" },
  { code: "en", label: "English" },
] as const;

export type AppLanguage = (typeof SUPPORTED_LANGUAGES)[number]["code"];

function detectLanguage(): AppLanguage {
  const saved = localStorage.getItem("devdeck.lang") as AppLanguage | null;
  if (saved === "zh" || saved === "en") return saved;
  const nav = navigator.language?.toLowerCase() ?? "";
  return nav.startsWith("zh") ? "zh" : "en";
}

const resources = {
  zh: { translation: zh },
  en: { translation: en },
} as const;

void i18n.use(initReactI18next).init({
  resources,
  lng: detectLanguage(),
  fallbackLng: "zh",
  interpolation: { escapeValue: false },
});

export function setLanguage(code: AppLanguage) {
  localStorage.setItem("devdeck.lang", code);
  void i18n.changeLanguage(code);
}

export default i18n;
