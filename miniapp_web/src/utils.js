import { t } from "./i18n";

export const SUPPLIER_CHOICES = ["DNS", "WB", "Online Trade", "Ozon", "Другое"];

export const DEFAULT_EXPENSE_FORM = {
  id: null,
  amount: "",
  description: "",
  date: "",
  expense_category: "",
  payment_account: "",
  payment_method: "",
  receipt_file: null,
  has_receipt: false,
  receipt_document_id: null,
};

export function createEmptySaleDraft() {
  return {
    saleAmount: "",
    usePrepayment: false,
    prepaymentAmount: "",
    usePostpayment: false,
    postpaymentAmount: "",
  };
}

export function getTelegramWebApp() {
  return window.Telegram?.WebApp;
}

export function getTelegramInitData() {
  const tg = getTelegramWebApp();
  if (tg?.initData) return String(tg.initData);
  const searchParams = new URLSearchParams(window.location.search);
  const hashValue = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  const hashParams = new URLSearchParams(hashValue);
  const fallback = searchParams.get("tgWebAppData") || hashParams.get("tgWebAppData") || searchParams.get("initData");
  return fallback ? String(fallback) : "";
}

export function normalizePhone(value) {
  const raw = String(value || "").trim();
  const cleaned = raw.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  if (!cleaned) return "";
  if (cleaned.startsWith("+")) return `+${cleaned.slice(1).replace(/\D/g, "")}`;
  return `+${cleaned.replace(/\D/g, "")}`;
}

export function isPhoneValid(value) {
  const normalized = normalizePhone(value);
  const digits = normalized.replace(/\D/g, "");
  return normalized.startsWith("+") && digits.length >= 10 && digits.length <= 15;
}

export function normalizeAmountInput(value) {
  let raw = String(value || "").replace(",", ".").replace(/[^0-9.]/g, "");
  const firstDot = raw.indexOf(".");
  if (firstDot >= 0) {
    raw = raw.slice(0, firstDot + 1) + raw.slice(firstDot + 1).replace(/\./g, "");
  }
  return raw;
}

export function parsePositiveAmount(value) {
  const normalized = normalizeAmountInput(value);
  if (!normalized) return 0;
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return amount;
}

export function formatAmount(amount) {
  return Number(amount || 0).toLocaleString("ru-RU");
}

export function formatDateTime(value) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatFileSize(bytes) {
  const value = Number(bytes || 0);
  if (value <= 0) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function toEpoch(value) {
  const parsed = new Date(value || "");
  const time = parsed.getTime();
  return Number.isFinite(time) ? time : 0;
}

export function downloadBlob(blob, filename) {
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename || "файл";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}

export function humanizeError(lang, error) {
  const raw = String(error?.message || "").trim();
  const lowered = raw.toLowerCase();
  if (!raw) return t(lang, "unknownError");
  if (lowered.includes("failed to fetch") || lowered.includes("networkerror") || lowered.includes("network error")) {
    return t(lang, "networkError");
  }
  if (lowered.includes("too many requests") || lowered.includes("429")) {
    return t(lang, "tooManyRequests");
  }
  if (lowered.includes("content too large") || lowered.includes("413")) {
    return t(lang, "fileTooLarge");
  }
  return raw;
}

export function withChangePrefix(text, { shouldMark, label }) {
  const value = String(text || "").trim();
  if (!shouldMark || !value) return value;
  const prefix = `${label}: `;
  if (value.startsWith(prefix)) return value;
  return `${prefix}${value}`;
}

export function orderMatchesQuery(order, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return true;
  const haystack = [order?.id, order?.order_phone, order?.client_name]
    .map((item) => String(item || "").toLowerCase())
    .join(" ");
  return haystack.includes(needle);
}

export function getRoleLabel(lang, role) {
  const normalized = String(role || "").trim().toLowerCase();
  if (normalized === "owner") return t(lang, "authRoleOwner");
  if (normalized === "operator") return t(lang, "authRoleOperator");
  return t(lang, "authRoleUser");
}
