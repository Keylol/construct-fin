import { useEffect, useMemo, useState } from "react";

import { apiDownload, apiRequest } from "./api";
import { SalesTab } from "./components/SalesTab";
import { PurchasesTab } from "./components/PurchasesTab";
import { StatsTab } from "./components/StatsTab";
import { t } from "./i18n";
import {
  DEFAULT_EXPENSE_FORM,
  createEmptySaleDraft,
  downloadBlob,
  formatAmount,
  getTelegramInitData,
  getTelegramWebApp,
  humanizeError,
  isPhoneValid,
  normalizeAmountInput,
  normalizePhone,
  orderMatchesQuery,
  parsePositiveAmount,
  toEpoch,
  withChangePrefix,
} from "./utils";

const TABS = ["sales", "purchases", "stats"];

function HeroMetricCard({ label, value, note }) {
  return (
    <article className="hero-metric-card compact-hero-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {note ? <small>{note}</small> : null}
    </article>
  );
}

export function App() {
  const lang = "ru";
  const [token, setToken] = useState("");
  const [userRole, setUserRole] = useState("");
  const [options, setOptions] = useState(null);
  const [orders, setOrders] = useState([]);
  const [operations, setOperations] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [orderTimelineOperations, setOrderTimelineOperations] = useState([]);
  const [summary, setSummary] = useState(null);
  const [reportDays, setReportDays] = useState(30);
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const [selectedOrderId, setSelectedOrderId] = useState("");
  const [salesScreen, setSalesScreen] = useState("list");
  const [salesListMode, setSalesListMode] = useState("create");
  const [orderSection, setOrderSection] = useState("components");
  const [salesQuery, setSalesQuery] = useState("");
  const [saleDraftByOrder, setSaleDraftByOrder] = useState({});
  const [componentDraftByOrder, setComponentDraftByOrder] = useState({});
  const [reopenedOrderIds, setReopenedOrderIds] = useState({});

  const [phone, setPhone] = useState("");
  const [clientName, setClientName] = useState("");
  const [componentName, setComponentName] = useState("");
  const [componentCost, setComponentCost] = useState("");
  const [componentSupplier, setComponentSupplier] = useState("");
  const [showSaleCloseConfirm, setShowSaleCloseConfirm] = useState(false);

  const [docType, setDocType] = useState("чек");
  const [docFile, setDocFile] = useState(null);
  const [expenseForm, setExpenseForm] = useState(DEFAULT_EXPENSE_FORM);

  const [globalStatus, setGlobalStatus] = useState("");
  const [globalStatusKind, setGlobalStatusKind] = useState("info");

  const [isBootstrapping, setIsBootstrapping] = useState(false);
  const [isOrdersLoading, setIsOrdersLoading] = useState(false);
  const [isOperationsLoading, setIsOperationsLoading] = useState(false);
  const [isOrderTimelineLoading, setIsOrderTimelineLoading] = useState(false);
  const [isDocumentsLoading, setIsDocumentsLoading] = useState(false);
  const [isReportsLoading, setIsReportsLoading] = useState(false);

  const [isCreatingOrder, setIsCreatingOrder] = useState(false);
  const [isAddingComponent, setIsAddingComponent] = useState(false);
  const [isFinalizingSale, setIsFinalizingSale] = useState(false);
  const [isUploadingDoc, setIsUploadingDoc] = useState(false);
  const [isExportingDocs, setIsExportingDocs] = useState(false);
  const [isExportingAllDocs, setIsExportingAllDocs] = useState(false);
  const [isSavingExpense, setIsSavingExpense] = useState(false);
  const [isSyncingSheets, setIsSyncingSheets] = useState(false);
  const [isUpdatingAiModel, setIsUpdatingAiModel] = useState(false);
  const [deletingOperationId, setDeletingOperationId] = useState(null);
  const [deletingOrderId, setDeletingOrderId] = useState(null);
  const [downloadingDocumentId, setDownloadingDocumentId] = useState(null);
  const [assistingDocumentId, setAssistingDocumentId] = useState(null);
  const [expandedDocumentAssistId, setExpandedDocumentAssistId] = useState(null);
  const [documentAssistById, setDocumentAssistById] = useState({});
  const [aiModelState, setAiModelState] = useState(null);
  const [reopeningOrderId, setReopeningOrderId] = useState(null);
  const [draftComponentActionId, setDraftComponentActionId] = useState(null);
  const [draftComponentCost, setDraftComponentCost] = useState("");
  const [draftComponentSupplier, setDraftComponentSupplier] = useState("");
  const [savingDraftComponentId, setSavingDraftComponentId] = useState(null);

  const hasAuth = Boolean(token);
  const isOwner = String(userRole || "").trim().toLowerCase() === "owner";
  const availableAiModels = aiModelState?.available_models || [];
  const tabItems = useMemo(
    () => [
      { key: "sales", label: t(lang, "tabSales") },
      { key: "purchases", label: t(lang, "tabPurchases") },
      { key: "stats", label: t(lang, "tabStats") },
    ],
    [lang],
  );

  const paymentAccounts = options?.payment_accounts || [];
  const paymentMethods = options?.payment_methods || ["карта", "наличные", "перевод"];
  const expenseCategories = options?.expense_categories || [];
  const documentTypes = options?.document_types || ["чек", "гарантия", "спецификация", "другое"];

  const normalizedPhone = normalizePhone(phone);
  const phoneValid = isPhoneValid(normalizedPhone);
  const componentCostValue = parsePositiveAmount(componentCost);
  const expenseAmountValue = parsePositiveAmount(expenseForm.amount);

  const sortedOrders = useMemo(
    () =>
      [...orders].sort((l, r) => {
        const diff = toEpoch(r.last_activity_at || r.updated_at) - toEpoch(l.last_activity_at || l.updated_at);
        return diff !== 0 ? diff : Number(r.id || 0) - Number(l.id || 0);
      }),
    [orders],
  );

  const openOrders = useMemo(
    () => sortedOrders.filter((o) => String(o.status || "").toLowerCase() === "open"),
    [sortedOrders],
  );
  const closedOrders = useMemo(
    () => sortedOrders.filter((o) => String(o.status || "").toLowerCase() === "closed"),
    [sortedOrders],
  );
  const selectedOrder = useMemo(
    () => orders.find((o) => String(o.id) === String(selectedOrderId)) || null,
    [orders, selectedOrderId],
  );
  const selectedOrderIsOpen = String(selectedOrder?.status || "").toLowerCase() === "open";
  const filteredOpenOrders = useMemo(
    () => openOrders.filter((o) => orderMatchesQuery(o, salesQuery)),
    [openOrders, salesQuery],
  );
  const filteredClosedOrders = useMemo(
    () => closedOrders.filter((o) => orderMatchesQuery(o, salesQuery)),
    [closedOrders, salesQuery],
  );
  const showOpenOrdersSearch = salesListMode === "active" && (salesQuery || openOrders.length > 4);
  const showClosedOrdersSearch = salesListMode === "history" && (salesQuery || closedOrders.length > 4);

  const activeSaleDraft = useMemo(
    () => (selectedOrderId ? saleDraftByOrder[selectedOrderId] || createEmptySaleDraft() : createEmptySaleDraft()),
    [saleDraftByOrder, selectedOrderId],
  );

  const saleAmountValue = parsePositiveAmount(activeSaleDraft.saleAmount);
  const prepaymentAmountValue = activeSaleDraft.usePrepayment ? parsePositiveAmount(activeSaleDraft.prepaymentAmount) : 0;
  const postpaymentAmountValue = activeSaleDraft.usePostpayment ? parsePositiveAmount(activeSaleDraft.postpaymentAmount) : 0;

  const recordedSaleAmount = Number(selectedOrder?.sale_amount || 0);
  const recordedPrepaymentAmount = Number(selectedOrder?.prepayment_amount || 0);
  const recordedPostpaymentAmount = Number(selectedOrder?.postpayment_amount || 0);
  const recordedPaymentReceiptAmount = Number(selectedOrder?.payment_receipt_amount || 0);
  const recordedRecognizedCogs = Number(selectedOrder?.recognized_cogs || 0);
  const hasRecordedSplitPayments = recordedPrepaymentAmount > 0 || recordedPostpaymentAmount > 0;

  const orderPurchaseOperations = useMemo(
    () => orderTimelineOperations.filter((o) => String(o.operation_type || "").toLowerCase() === "закупка"),
    [orderTimelineOperations],
  );
  const activeComponentDraft = useMemo(
    () => (selectedOrderId ? componentDraftByOrder[selectedOrderId] || [] : []),
    [componentDraftByOrder, selectedOrderId],
  );
  const componentsCostTotal = orderPurchaseOperations.reduce((s, o) => s + Number(o.amount || 0), 0);
  const plannedPaidAmount =
    activeSaleDraft.usePrepayment || activeSaleDraft.usePostpayment || hasRecordedSplitPayments
      ? prepaymentAmountValue + postpaymentAmountValue
      : saleAmountValue;
  const saleProfit = saleAmountValue - componentsCostTotal;
  const saleBalanceDue = Math.max(saleAmountValue - plannedPaidAmount, 0);

  const businessExpenses = useMemo(
    () => operations.filter((o) => String(o.operation_type || "").toLowerCase() === "расход" && !o.order_id),
    [operations],
  );
  const businessExpensesTotal = useMemo(
    () => businessExpenses.reduce((s, o) => s + Number(o.amount || 0), 0),
    [businessExpenses],
  );

  const selectedOrderTimeline = useMemo(() => {
    if (!selectedOrderId) return [];
    const opEvents = orderTimelineOperations.map((o) => ({
      id: `op_${o.id}`,
      kind: "operation",
      sortAt: toEpoch(o.created_at || o.date),
      title: o.operation_type,
      subtitle: o.description,
      meta: [o.date, o.payment_account, o.supplier].filter(Boolean).join(" · "),
      amount: `${formatAmount(o.amount)} ₽`,
      operationId: o.id,
      tone:
        o.operation_type === "продажа" || o.operation_type === "корректировка продажи"
          ? "success"
          : o.operation_type === "предоплата" || o.operation_type === "постоплата" || o.operation_type === "оплата"
            ? "info"
            : o.operation_type === "закупка" || o.operation_type === "себестоимость"
              ? "warning"
              : "default",
    }));
    const docEvents = documents.map((d) => ({
      id: `doc_${d.id}`,
      kind: "document",
      sortAt: toEpoch(d.uploaded_at),
      title: `${t(lang, "orderFilesTitle")}: ${d.doc_type}`,
      subtitle: d.file_name,
      meta: null,
      amount: null,
      operationId: null,
      tone: "doc",
    }));
    return [...opEvents, ...docEvents].sort((a, b) => b.sortAt - a.sortAt);
  }, [documents, lang, orderTimelineOperations, selectedOrderId]);

  const statsTotals = useMemo(() => {
    const sales = Number(summary?.income || 0);
    const cogs = Number(summary?.purchases || 0);
    const other = Number(summary?.other_expenses || 0);
    const profit = Number(summary?.profit || 0);
    const peak = Math.max(sales, cogs, other, Math.abs(profit), 1);
    return {
      sales, cogs, other, profit,
      positiveProfit: Math.max(profit, 0),
      loss: Math.max(cogs + other - sales, 0),
      bars: [
        { key: "sales", labelKey: "incomeMetric", value: sales, percent: Math.max(6, (sales / peak) * 100), negative: false },
        { key: "cogs", labelKey: "cogsMetric", value: cogs, percent: Math.max(6, (cogs / peak) * 100), negative: false },
        { key: "other", labelKey: "otherExpensesMetric", value: other, percent: Math.max(6, (other / peak) * 100), negative: false },
        { key: "profit", labelKey: "profitMetric", value: profit, percent: Math.max(6, (Math.abs(profit) / peak) * 100), negative: profit < 0 },
      ],
    };
  }, [summary]);

  const reportPeriodLabel = useMemo(() => {
    if (reportDays === 1) return t(lang, "periodToday");
    if (reportDays === 7) return t(lang, "periodWeek");
    return t(lang, "periodMonth");
  }, [lang, reportDays]);

  const selectedOrderProfit = Number(selectedOrder?.sale_amount || saleAmountValue || 0) - Number(selectedOrder?.purchase_cost || componentsCostTotal || 0);
  const orderHasComponents = orderPurchaseOperations.length > 0;
  const orderHasSale = Number(selectedOrder?.sale_amount || saleAmountValue || 0) > 0;
  const orderFilesCount = Number(selectedOrder?.documents_count || documents.length || 0);
  const orderHasFiles = orderFilesCount > 0;
  const orderHasBalanceDue = Number(selectedOrder?.balance_due || saleBalanceDue || 0) > 0.01;
  const orderNextStep = useMemo(() => {
    if (!selectedOrder) return null;
    if (!orderHasComponents) return { section: "components", title: t(lang, "nextStepComponents"), actionLabel: t(lang, "orderTabComponents") };
    if (!orderHasSale) return { section: "sale", title: t(lang, "nextStepSale"), actionLabel: t(lang, "orderTabSale") };
    if (!orderHasFiles) return { section: "files", title: t(lang, "nextStepFiles"), actionLabel: t(lang, "orderTabFiles") };
    if (orderHasBalanceDue) return { section: "sale", title: t(lang, "nextStepBalance"), actionLabel: t(lang, "orderTabSale") };
    return { section: "timeline", title: t(lang, "nextStepDone"), actionLabel: t(lang, "orderTabTimeline"), done: true };
  }, [lang, orderHasBalanceDue, orderHasComponents, orderHasFiles, orderHasSale, selectedOrder]);

  function setStatus(kind, text) {
    setGlobalStatusKind(kind);
    setGlobalStatus(text);
  }

  useEffect(() => {
    if (!globalStatus || globalStatusKind === "error") return;
    const id = window.setTimeout(() => setGlobalStatus(""), 1800);
    return () => window.clearTimeout(id);
  }, [globalStatus, globalStatusKind]);

  function updateSaleDraft(mutator) {
    if (!selectedOrderId) return;
    setSaleDraftByOrder((prev) => ({
      ...prev,
      [selectedOrderId]: mutator(prev[selectedOrderId] || createEmptySaleDraft()),
    }));
  }

  useEffect(() => {
    const tg = getTelegramWebApp();
    tg?.ready();
    tg?.expand();
  }, []);

  useEffect(() => {
    if (token || isBootstrapping) return;
    let timeoutId = 0;
    let attempts = 0;
    const MAX_ATTEMPTS = 40; // 40 × 375ms = 15 seconds
    const tryBootstrapAuth = () => {
      const initData = getTelegramInitData();
      if (initData) { handleTelegramAuth(initData); return; }
      attempts += 1;
      if (attempts < MAX_ATTEMPTS) timeoutId = window.setTimeout(tryBootstrapAuth, 375);
    };
    // Also re-try immediately after window load event fires
    const onLoad = () => {
      window.clearTimeout(timeoutId);
      attempts = 0;
      tryBootstrapAuth();
    };
    window.addEventListener("load", onLoad, { once: true });
    tryBootstrapAuth();
    return () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener("load", onLoad);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBootstrapping, token]);

  useEffect(
    () => () => {
      const tg = getTelegramWebApp();
      tg?.MainButton?.hide();
      tg?.BackButton?.hide();
    },
    [],
  );

  useEffect(() => {
    if (!token || !selectedOrderId || salesScreen !== "order") {
      setDocuments([]);
      setOrderTimelineOperations([]);
      setExpandedDocumentAssistId(null);
      setDocumentAssistById({});
      return;
    }
    Promise.all([loadDocuments(token, Number(selectedOrderId)), loadOrderTimeline(token, Number(selectedOrderId))]).catch((err) => {
      setStatus("error", t(lang, "createFail", { error: humanizeError(lang, err) }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salesScreen, token, selectedOrderId]);

  useEffect(() => {
    if (!selectedOrderId || !selectedOrder) return;
    setSaleDraftByOrder((prev) => {
      const current = prev[selectedOrderId] ? { ...prev[selectedOrderId] } : createEmptySaleDraft();
      let changed = false;
      if (!current.saleAmount && Number(selectedOrder.sale_amount || 0) > 0) {
        current.saleAmount = normalizeAmountInput(selectedOrder.sale_amount);
        changed = true;
      }
      if (Number(selectedOrder.prepayment_amount || 0) > 0 && !current.usePrepayment) {
        current.usePrepayment = true;
        current.prepaymentAmount = current.prepaymentAmount || normalizeAmountInput(selectedOrder.prepayment_amount);
        changed = true;
      }
      if (Number(selectedOrder.postpayment_amount || 0) > 0 && !current.usePostpayment) {
        current.usePostpayment = true;
        current.postpaymentAmount = current.postpaymentAmount || normalizeAmountInput(selectedOrder.postpayment_amount);
        changed = true;
      }
      return changed ? { ...prev, [selectedOrderId]: current } : prev;
    });
  }, [selectedOrder, selectedOrderId]);

  useEffect(() => { setShowSaleCloseConfirm(false); }, [selectedOrderId]);
  useEffect(() => {
    if (salesScreen === "order" && !selectedOrder) { setSalesScreen("list"); setOrderSection("components"); }
  }, [salesScreen, selectedOrder]);
  useEffect(() => {
    if (salesScreen === "order") setOrderSection("components");
  }, [selectedOrderId, salesScreen]);
  useEffect(() => {
    if (!paymentAccounts.length) return;
    setExpenseForm((prev) => ({ ...prev, payment_account: prev.payment_account || paymentAccounts[0] }));
  }, [paymentAccounts]);
  useEffect(() => {
    if (!token || isBootstrapping) return;
    loadReports(token, reportDays).catch((err) => {
      setStatus("error", t(lang, "createFail", { error: humanizeError(lang, err) }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBootstrapping, reportDays, token]);
  useEffect(() => {
    if (!token || !isOwner || activeTabIndex !== 2 || aiModelState) return;
    loadAiModelState(token, true).catch((err) => {
      setStatus("error", t(lang, "createFail", { error: humanizeError(lang, err) }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabIndex, aiModelState, isOwner, token]);

  useEffect(() => {
    const tg = getTelegramWebApp();
    if (!tg?.MainButton) return;
    if (!hasAuth) {
      tg.MainButton.hide();
      return;
    }
    const onMainButton = () => handleRefreshData();
    tg.MainButton.setText(t(lang, "tgMainRefresh"));
    tg.MainButton.show();
    if (isBootstrapping || isReportsLoading || isOrdersLoading || isOperationsLoading) {
      tg.MainButton.disable?.();
      tg.MainButton.showProgress?.(false);
    } else {
      tg.MainButton.enable?.();
      tg.MainButton.hideProgress?.();
    }
    tg.MainButton.onClick(onMainButton);
    return () => { tg.MainButton.offClick(onMainButton); tg.MainButton.hideProgress?.(); };
  }, [hasAuth, isBootstrapping, isOperationsLoading, isOrdersLoading, isReportsLoading, lang]);

  useEffect(() => {
    const tg = getTelegramWebApp();
    if (!tg?.BackButton) return;
    const shouldShow = hasAuth && activeTabIndex === 0 && salesScreen === "order";
    const onBack = () => { setSalesScreen("list"); setShowSaleCloseConfirm(false); };
    if (shouldShow) { tg.BackButton.show(); tg.BackButton.onClick(onBack); }
    else { tg.BackButton.hide(); }
    return () => { tg.BackButton.offClick(onBack); tg.BackButton.hide(); };
  }, [activeTabIndex, hasAuth, salesScreen]);

  // --- Data loaders ---

  async function loadOptions(tok) {
    const payload = await apiRequest("/meta/options", { token: tok });
    setOptions(payload);
  }

  async function loadOrders(tok) {
    setIsOrdersLoading(true);
    try {
      const payload = await apiRequest("/orders", { token: tok });
      setOrders(payload);
      setSelectedOrderId((prev) => {
        const previous = String(prev || "");
        if (payload.some((o) => String(o.id) === previous)) return previous;
        const firstOpen = payload.find((o) => String(o.status || "").toLowerCase() === "open");
        if (firstOpen) return String(firstOpen.id);
        return payload[0] ? String(payload[0].id) : "";
      });
    } finally {
      setIsOrdersLoading(false);
    }
  }

  async function loadOperations(tok) {
    setIsOperationsLoading(true);
    try {
      const payload = await apiRequest("/operations", { token: tok });
      setOperations(payload);
    } finally {
      setIsOperationsLoading(false);
    }
  }

  async function loadOrderTimeline(tok, orderId) {
    setIsOrderTimelineLoading(true);
    try {
      const payload = await apiRequest(`/operations?order_id=${orderId}`, { token: tok });
      setOrderTimelineOperations(payload);
    } finally {
      setIsOrderTimelineLoading(false);
    }
  }

  async function loadDocuments(tok, orderId) {
    setIsDocumentsLoading(true);
    try {
      const payload = await apiRequest(`/documents?order_id=${orderId}`, { token: tok });
      setDocuments(payload);
      const aliveIds = new Set(payload.map((d) => String(d.id)));
      setDocumentAssistById((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => aliveIds.has(String(k)))));
      setExpandedDocumentAssistId((prev) => (prev && !aliveIds.has(String(prev)) ? null : prev));
    } finally {
      setIsDocumentsLoading(false);
    }
  }

  async function loadReports(tok, days = reportDays) {
    setIsReportsLoading(true);
    try {
      const payload = await apiRequest(`/reports/summary?days=${days}`, { token: tok });
      setSummary(payload);
    } finally {
      setIsReportsLoading(false);
    }
  }

  async function loadAiModelState(tok, forceOwner = false) {
    if (!tok || !(forceOwner || isOwner)) { setAiModelState(null); return; }
    const payload = await apiRequest("/admin/ai-model", { token: tok });
    setAiModelState(payload);
  }

  // --- Auth & global handlers ---

  async function handleTelegramAuth(initDataOverride = "") {
    const initData = String(initDataOverride || getTelegramInitData() || "");
    if (!initData) {
      // Don't show error — just silently wait, user can retry manually
      return;
    }
    setIsBootstrapping(true);
    try {
      const result = await apiRequest("/auth/telegram", { method: "POST", body: JSON.stringify({ initData }) });
      const nextToken = result.access_token;
      const nextRole = result.user.role || "";
      setToken(nextToken);
      setUserRole(nextRole);
      setAiModelState(null);
      setActiveTabIndex(0);
      await Promise.all([loadOptions(nextToken), loadOrders(nextToken), loadOperations(nextToken), loadReports(nextToken, reportDays)]);
      setStatus("success", t(lang, "dataSynced"));
    } catch (err) {
      setUserRole("");
      setStatus("error", t(lang, "authFail", { error: humanizeError(lang, err) }));
    } finally {
      setIsBootstrapping(false);
    }
  }

  async function handleRefreshData() {
    if (!token) return;
    try {
      await Promise.all([
        loadOrders(token),
        loadOperations(token),
        loadReports(token, reportDays),
        isOwner && activeTabIndex === 2 ? loadAiModelState(token, true) : Promise.resolve(),
      ]);
      if (selectedOrderId) {
        await Promise.all([loadDocuments(token, Number(selectedOrderId)), loadOrderTimeline(token, Number(selectedOrderId))]);
      }
      setStatus("success", t(lang, "dataSynced"));
    } catch (err) {
      setStatus("error", t(lang, "createFail", { error: humanizeError(lang, err) }));
    }
  }

  async function handleGoogleSheetsSync() {
    if (!token || !isOwner) return;
    setIsSyncingSheets(true);
    setStatus("info", t(lang, "sheetsSyncing"));
    try {
      await apiRequest("/admin/google-sheets/sync", { token, method: "POST" });
      setStatus("success", t(lang, "sheetsSyncDone"));
    } catch (err) {
      setStatus("error", t(lang, "sheetsSyncFail", { error: humanizeError(lang, err) }));
    } finally {
      setIsSyncingSheets(false);
    }
  }

  async function handleAiModelChange(event) {
    const nextModel = String(event.target.value || "");
    if (!token || !isOwner || !nextModel) return;
    setIsUpdatingAiModel(true);
    try {
      const payload = await apiRequest("/admin/ai-model", { token, method: "POST", body: JSON.stringify({ model: nextModel }) });
      setAiModelState(payload);
      setStatus("success", t(lang, "aiModelUpdated"));
    } catch (err) {
      setStatus("error", t(lang, "aiModelUpdateFail", { error: humanizeError(lang, err) }));
    } finally {
      setIsUpdatingAiModel(false);
    }
  }

  // --- Order handlers ---

  async function handleCreateOrder(event) {
    event.preventDefault();
    if (!token) { setStatus("info", t(lang, "signInToContinue")); return; }
    if (!phoneValid) { setStatus("error", t(lang, "invalidPhone")); return; }
    setIsCreatingOrder(true);
    try {
      const created = await apiRequest("/orders", {
        token, method: "POST",
        body: JSON.stringify({ order_phone: normalizedPhone, client_name: clientName.trim() || null }),
      });
      setPhone("");
      setClientName("");
      setSelectedOrderId(String(created.id));
      setSalesScreen("order");
      setSalesListMode("active");
      await loadOrders(token);
      setStatus("success", t(lang, "orderCreated"));
    } catch (err) {
      setStatus("error", t(lang, "createFail", { error: humanizeError(lang, err) }));
    } finally {
      setIsCreatingOrder(false);
    }
  }

  async function createOrderPurchase({ name, amount, supplier }) {
    const shouldMarkChange = Boolean(reopenedOrderIds[selectedOrderId]);
    await apiRequest("/operations/manual", {
      token, method: "POST",
      body: JSON.stringify({
        operation_type: "закупка",
        description: withChangePrefix(`${t(lang, "componentNameLabel")}: ${name}`, {
          shouldMark: shouldMarkChange,
          label: t(lang, "changeMark"),
        }),
        amount,
        order_id: Number(selectedOrderId),
        supplier: supplier || null,
      }),
    });
    await Promise.all([loadOrders(token), loadOperations(token), loadReports(token, reportDays), loadOrderTimeline(token, Number(selectedOrderId))]);
  }

  async function handleAddComponent(event) {
    event.preventDefault();
    if (!token || !selectedOrderId) { setStatus("info", t(lang, "selectOrderForSale")); return; }
    if (!selectedOrderIsOpen) { setStatus("info", t(lang, "selectOpenOrderForSale")); return; }
    if (!componentName.trim() || componentCostValue <= 0) { setStatus("error", t(lang, "requiredComponentFields")); return; }
    setIsAddingComponent(true);
    try {
      await createOrderPurchase({ name: componentName.trim(), amount: componentCostValue, supplier: componentSupplier.trim() || null });
      setComponentName("");
      setComponentCost("");
      setComponentSupplier("");
      setStatus("success", t(lang, "componentAdded"));
    } catch (err) {
      setStatus("error", t(lang, "operationSaveFail", { error: humanizeError(lang, err) }));
    } finally {
      setIsAddingComponent(false);
    }
  }

  function handlePrepareOrderFinalize() {
    if (!selectedOrderId || !selectedOrder) { setStatus("info", t(lang, "selectOrderForSale")); return; }
    if (!selectedOrderIsOpen) { setStatus("info", t(lang, "selectOpenOrderForSale")); return; }
    if (componentsCostTotal <= 0) { setStatus("info", t(lang, "addComponentsFirst")); return; }
    if (saleAmountValue <= 0) { setStatus("error", t(lang, "saleTotalRequired")); return; }
    const splitIncomeMode = activeSaleDraft.usePrepayment || activeSaleDraft.usePostpayment || hasRecordedSplitPayments;
    const totalPaid = prepaymentAmountValue + postpaymentAmountValue;
    if (splitIncomeMode) {
      if (totalPaid <= 0) { setStatus("error", t(lang, "prepostAmountRequired")); return; }
      if (prepaymentAmountValue < recordedPrepaymentAmount || postpaymentAmountValue < recordedPostpaymentAmount) {
        setStatus("error", t(lang, "paymentLessThanRecorded")); return;
      }
      if (totalPaid - saleAmountValue > 0.01) { setStatus("error", t(lang, "prepostMustMatchSale")); return; }
    } else if (saleAmountValue + 0.01 < recordedPaymentReceiptAmount) {
      setStatus("error", t(lang, "paymentLessThanRecorded")); return;
    }
    setShowSaleCloseConfirm(true);
  }

  async function handleFinalizeSaleAndClose() {
    if (!token || !selectedOrderId) return;
    setIsFinalizingSale(true);
    try {
      const orderId = Number(selectedOrderId);
      const isChangedFlow = Boolean(reopenedOrderIds[selectedOrderId]);
      const changePrefix = isChangedFlow ? `${t(lang, "changeMark")}: ` : "";
      const splitIncomeMode = activeSaleDraft.usePrepayment || activeSaleDraft.usePostpayment || hasRecordedSplitPayments;
      const totalPaid = prepaymentAmountValue + postpaymentAmountValue;
      const shouldCloseOrder = !splitIncomeMode || Math.abs(totalPaid - saleAmountValue) <= 0.01;
      const saleDelta = Number((saleAmountValue - recordedSaleAmount).toFixed(2));
      const prepaymentDelta = Math.max(0, prepaymentAmountValue - recordedPrepaymentAmount);
      const postpaymentDelta = Math.max(0, postpaymentAmountValue - recordedPostpaymentAmount);
      const paymentReceiptDelta = Math.max(0, Number((saleAmountValue - recordedPaymentReceiptAmount).toFixed(2)));
      const cogsDelta = Number((componentsCostTotal - recordedRecognizedCogs).toFixed(2));

      if (Math.abs(saleDelta) > 0.009) {
        await apiRequest("/operations/manual", {
          token, method: "POST",
          body: JSON.stringify({
            operation_type: recordedSaleAmount > 0 ? "корректировка продажи" : "продажа",
            description: `${changePrefix}${t(lang, "saleOperationLabel")}`,
            amount: saleDelta, order_id: orderId,
          }),
        });
      }
      if (splitIncomeMode) {
        if (prepaymentDelta > 0) {
          await apiRequest("/operations/manual", {
            token, method: "POST",
            body: JSON.stringify({ operation_type: "предоплата", description: `${changePrefix}${t(lang, "prepaymentOperationLabel")}`, amount: prepaymentDelta, order_id: orderId }),
          });
        }
        if (postpaymentDelta > 0) {
          await apiRequest("/operations/manual", {
            token, method: "POST",
            body: JSON.stringify({ operation_type: "постоплата", description: `${changePrefix}${t(lang, "postpaymentOperationLabel")}`, amount: postpaymentDelta, order_id: orderId }),
          });
        }
      } else if (paymentReceiptDelta > 0) {
        await apiRequest("/operations/manual", {
          token, method: "POST",
          body: JSON.stringify({ operation_type: "оплата", description: `${changePrefix}${t(lang, "saleOperationLabel")}`, amount: paymentReceiptDelta, order_id: orderId }),
        });
      }
      if (shouldCloseOrder) {
        if (Math.abs(cogsDelta) > 0.009) {
          await apiRequest("/operations/manual", {
            token, method: "POST",
            body: JSON.stringify({ operation_type: "себестоимость", description: `${changePrefix}${t(lang, "componentsTotalLabel")}`, amount: cogsDelta, order_id: orderId }),
          });
        }
        await apiRequest(`/orders/${orderId}/close`, { token, method: "POST" });
        setSaleDraftByOrder((prev) => { const next = { ...prev }; delete next[selectedOrderId]; return next; });
      }
      setShowSaleCloseConfirm(false);
      await Promise.all([loadOrders(token), loadOperations(token), loadReports(token, reportDays), loadDocuments(token, orderId), loadOrderTimeline(token, orderId)]);
      setStatus("success", shouldCloseOrder ? t(lang, "saleOrderClosed") : t(lang, "saleOrderSavedOpen"));
    } catch (err) {
      setStatus("error", t(lang, "createFail", { error: humanizeError(lang, err) }));
    } finally {
      setIsFinalizingSale(false);
    }
  }

  async function handleReopenOrder(orderId) {
    if (!token) return;
    setReopeningOrderId(orderId);
    try {
      await apiRequest(`/orders/${orderId}/reopen`, { token, method: "POST" });
      setReopenedOrderIds((prev) => ({ ...prev, [String(orderId)]: true }));
      setSelectedOrderId(String(orderId));
      setSalesScreen("order");
      setOrderSection("components");
      setSalesListMode("active");
      await loadOrders(token);
      setStatus("success", t(lang, "orderReopened"));
    } catch (err) {
      setStatus("error", t(lang, "createFail", { error: humanizeError(lang, err) }));
    } finally {
      setReopeningOrderId(null);
    }
  }

  async function handleDeleteOrder(orderId) {
    if (!token || !window.confirm(t(lang, "deleteOrderConfirm"))) return;
    setDeletingOrderId(orderId);
    try {
      await apiRequest(`/orders/${orderId}`, { token, method: "DELETE" });
      if (String(selectedOrderId) === String(orderId)) {
        setSelectedOrderId("");
        setSalesScreen("list");
        setDocuments([]);
        setOrderTimelineOperations([]);
        setShowSaleCloseConfirm(false);
        setOrderSection("components");
      }
      await Promise.all([loadOrders(token), loadOperations(token), loadReports(token, reportDays)]);
      setStatus("success", t(lang, "orderDeleted"));
    } catch (err) {
      setStatus("error", t(lang, "createFail", { error: humanizeError(lang, err) }));
    } finally {
      setDeletingOrderId(null);
    }
  }

  async function handleDeleteOperation(operationId) {
    if (!token || !window.confirm(t(lang, "deleteOperationConfirm"))) return;
    setDeletingOperationId(operationId);
    try {
      await apiRequest(`/operations/${operationId}`, { token, method: "DELETE" });
      if (expenseForm.id === operationId) {
        setExpenseForm({ ...DEFAULT_EXPENSE_FORM, payment_account: paymentAccounts[0] || "" });
      }
      await Promise.all([loadOrders(token), loadOperations(token), loadReports(token, reportDays)]);
      if (selectedOrderId) {
        await Promise.all([loadDocuments(token, Number(selectedOrderId)), loadOrderTimeline(token, Number(selectedOrderId))]);
      }
      setStatus("success", t(lang, "operationDeleted"));
    } catch (err) {
      setStatus("error", t(lang, "createFail", { error: humanizeError(lang, err) }));
    } finally {
      setDeletingOperationId(null);
    }
  }

  // --- Document handlers ---

  async function handleUploadDocument(event) {
    event.preventDefault();
    if (!token || !selectedOrderId || !docFile) { setStatus("info", t(lang, "selectOrderForDocs")); return; }
    setIsUploadingDoc(true);
    try {
      const formData = new FormData();
      formData.append("order_id", String(selectedOrderId));
      formData.append("doc_type", String(docType || "другое"));
      formData.append("file", docFile);
      await apiRequest("/documents", { token, method: "POST", body: formData, isFormData: true });
      setDocFile(null);
      await Promise.all([loadDocuments(token, Number(selectedOrderId)), loadOrders(token)]);
      setStatus("success", t(lang, "documentUploaded"));
    } catch (err) {
      setStatus("error", t(lang, "createFail", { error: humanizeError(lang, err) }));
    } finally {
      setIsUploadingDoc(false);
    }
  }

  async function handleDownloadDocument(documentId) {
    if (!token) return;
    setDownloadingDocumentId(documentId);
    try {
      const result = await apiDownload(`/documents/${documentId}/download`, { token });
      downloadBlob(result.blob, result.filename || `document_${documentId}`);
      setStatus("success", t(lang, "documentDownloaded"));
    } catch (err) {
      setStatus("error", t(lang, "createFail", { error: humanizeError(lang, err) }));
    } finally {
      setDownloadingDocumentId(null);
    }
  }

  async function handleAssistDocument(documentId) {
    if (!token) return;
    if (expandedDocumentAssistId === documentId) { setExpandedDocumentAssistId(null); return; }
    if (documentAssistById[documentId]) { setExpandedDocumentAssistId(documentId); return; }
    setAssistingDocumentId(documentId);
    try {
      const payload = await apiRequest(`/documents/${documentId}/assist`, { token, method: "POST" });
      setDocumentAssistById((prev) => ({ ...prev, [documentId]: payload }));
      setExpandedDocumentAssistId(documentId);
    } catch (err) {
      setStatus("error", t(lang, "assistDocumentFail", { error: humanizeError(lang, err) }));
    } finally {
      setAssistingDocumentId(null);
    }
  }

  function handleApplyAssistSale(documentId) {
    const payload = documentAssistById[documentId];
    const customerTotal = Number(payload?.customer_total || 0);
    if (!selectedOrderId || !customerTotal) return;
    updateSaleDraft((d) => ({ ...d, saleAmount: normalizeAmountInput(String(customerTotal)) }));
    setShowSaleCloseConfirm(false);
    setOrderSection("sale");
    setStatus("success", t(lang, "assistAppliedSale"));
  }

  function handleApplyAssistComponents(documentId) {
    if (!selectedOrderId) return;
    const payload = documentAssistById[documentId];
    const parsedItems = Array.isArray(payload?.parsed_items) ? payload.parsed_items : [];
    if (!parsedItems.length) { setStatus("info", t(lang, "assistNothingToApply")); return; }
    setComponentDraftByOrder((prev) => ({
      ...prev,
      [selectedOrderId]: parsedItems.map((item, i) => ({
        id: `${documentId}_${i}_${String(item.component_name || "").trim()}`,
        component_name: String(item.component_name || "").trim(),
        component_value: String(item.component_value || "").trim(),
        confidence: item.confidence ?? null,
      })),
    }));
    setOrderSection("components");
    setStatus("success", t(lang, "assistAppliedComponents"));
  }

  async function handleApplyAssistIdentity(documentId) {
    if (!token || !selectedOrderId || !selectedOrder) return;
    const payload = documentAssistById[documentId];
    const nextBody = {};
    const nextClientName = String(payload?.customer_name || "").trim();
    const nextOrderPhone = normalizePhone(String(payload?.order_phone || ""));
    if (nextClientName && nextClientName !== String(selectedOrder.client_name || "").trim()) nextBody.client_name = nextClientName;
    if (nextOrderPhone && nextOrderPhone !== String(selectedOrder.order_phone || "").trim()) nextBody.order_phone = nextOrderPhone;
    if (!Object.keys(nextBody).length) { setStatus("info", t(lang, "assistNothingToApply")); return; }
    try {
      await apiRequest(`/orders/${selectedOrderId}`, { token, method: "PUT", body: JSON.stringify(nextBody) });
      await loadOrders(token);
      setStatus("success", t(lang, "assistAppliedClient"));
    } catch (err) {
      setStatus("error", t(lang, "createFail", { error: humanizeError(lang, err) }));
    }
  }

  // --- Draft component handlers ---

  function handleUseDraftComponent(itemId) {
    const draftItem = activeComponentDraft.find((d) => String(d.id) === String(itemId));
    if (!draftItem) return;
    setComponentName([draftItem.component_name, draftItem.component_value].filter(Boolean).join(": "));
    setComponentCost("");
    setComponentSupplier("");
    setStatus("success", t(lang, "draftComponentLoaded"));
  }

  function startDraftComponentQuickAdd(itemId) {
    setDraftComponentActionId(itemId);
    setDraftComponentCost("");
    setDraftComponentSupplier("");
  }

  function cancelDraftComponentQuickAdd() {
    setDraftComponentActionId(null);
    setDraftComponentCost("");
    setDraftComponentSupplier("");
  }

  async function handleSaveDraftComponent(itemId) {
    const draftItem = activeComponentDraft.find((d) => String(d.id) === String(itemId));
    const amount = parsePositiveAmount(draftComponentCost);
    if (!draftItem || !token || !selectedOrderId || amount <= 0) {
      setStatus("error", t(lang, "requiredComponentFields"));
      return;
    }
    setSavingDraftComponentId(itemId);
    try {
      await createOrderPurchase({
        name: [draftItem.component_name, draftItem.component_value].filter(Boolean).join(": "),
        amount,
        supplier: draftComponentSupplier.trim() || null,
      });
      setComponentDraftByOrder((prev) => ({
        ...prev,
        [selectedOrderId]: (prev[selectedOrderId] || []).filter((d) => String(d.id) !== String(itemId)),
      }));
      cancelDraftComponentQuickAdd();
      setStatus("success", t(lang, "draftAddedToOrder"));
    } catch (err) {
      setStatus("error", t(lang, "operationSaveFail", { error: humanizeError(lang, err) }));
    } finally {
      setSavingDraftComponentId(null);
    }
  }

  function handleClearComponentDraft() {
    if (!selectedOrderId) return;
    setComponentDraftByOrder((prev) => { const next = { ...prev }; delete next[selectedOrderId]; return next; });
  }

  async function handleExportOrderDocuments() {
    if (!token || !selectedOrderId) return;
    setIsExportingDocs(true);
    try {
      const result = await apiDownload(`/documents/order/${selectedOrderId}/export`, { token });
      downloadBlob(result.blob, result.filename || `order_${selectedOrderId}_documents.zip`);
      setStatus("success", t(lang, "documentsExported"));
    } catch (err) {
      setStatus("error", t(lang, "createFail", { error: humanizeError(lang, err) }));
    } finally {
      setIsExportingDocs(false);
    }
  }

  async function handleExportAllDocuments() {
    if (!token || !isOwner) return;
    setIsExportingAllDocs(true);
    try {
      const result = await apiDownload("/documents/export/all", { token });
      downloadBlob(result.blob, result.filename || "constructpc_documents_export.zip");
      setStatus("success", t(lang, "allDocumentsExported"));
    } catch (err) {
      setStatus("error", t(lang, "createFail", { error: humanizeError(lang, err) }));
    } finally {
      setIsExportingAllDocs(false);
    }
  }

  // --- Expense handlers ---

  function startExpenseEdit(item) {
    setExpenseForm({
      id: item.id,
      amount: normalizeAmountInput(item.amount),
      description: item.description || "",
      date: item.date || "",
      expense_category: item.expense_category || "",
      payment_account: item.payment_account || paymentAccounts[0] || "",
      payment_method: item.payment_method || "",
    });
  }

  function resetExpenseForm() {
    setExpenseForm({ ...DEFAULT_EXPENSE_FORM, payment_account: paymentAccounts[0] || "" });
  }

  async function handleSaveExpense(event) {
    event.preventDefault();
    if (!token) { setStatus("info", t(lang, "signInToContinue")); return; }
    if (!expenseForm.expense_category || expenseAmountValue <= 0 || !expenseForm.description.trim()) {
      setStatus("error", t(lang, "requiredFieldsHint")); return;
    }
    setIsSavingExpense(true);
    try {
      const payload = {
        operation_type: "расход",
        description: expenseForm.description.trim(),
        amount: expenseAmountValue,
        date: expenseForm.date || null,
        expense_category: expenseForm.expense_category,
        payment_account: expenseForm.payment_account || null,
        payment_method: expenseForm.payment_method || null,
      };
      if (expenseForm.id) {
        await apiRequest(`/operations/${expenseForm.id}`, { token, method: "PUT", body: JSON.stringify(payload) });
        setStatus("success", t(lang, "operationUpdated"));
      } else {
        await apiRequest("/operations/manual", { token, method: "POST", body: JSON.stringify(payload) });
        setStatus("success", t(lang, "operationSaved"));
      }
      resetExpenseForm();
      await Promise.all([loadOperations(token), loadReports(token, reportDays)]);
    } catch (err) {
      setStatus("error", t(lang, "operationSaveFail", { error: humanizeError(lang, err) }));
    } finally {
      setIsSavingExpense(false);
    }
  }

  // --- Navigation helpers ---

  function openSalesOrder(orderId) {
    setSelectedOrderId(String(orderId));
    setSalesScreen("order");
    setOrderSection("components");
  }

  function returnToSalesList() {
    setSalesScreen("list");
    setShowSaleCloseConfirm(false);
    setOrderSection("components");
  }

  // --- Render ---

  return (
    <main className="app">
      <header className={hasAuth ? "brand-hero panel brand-hero-authenticated" : "brand-hero panel"}>
        <div className="app-header-row">
          <h1>{t(lang, "heroHeadline")}</h1>
          {!hasAuth ? (
            <button type="button" className="small-button secondary header-action-button" onClick={handleTelegramAuth} disabled={isBootstrapping}>
              {isBootstrapping ? "…" : "↻"}
            </button>
          ) : (
            <button
              type="button"
              className="small-button secondary header-action-button"
              onClick={handleRefreshData}
              disabled={isBootstrapping || isReportsLoading || isOrdersLoading || isOperationsLoading}
            >
              {t(lang, "tgMainRefreshShort")}
            </button>
          )}
        </div>
        <div className="hero-metrics-grid compact-summary-row">
          <HeroMetricCard label={t(lang, "openOrdersMetric")} value={hasAuth ? String(openOrders.length) : "—"} note={t(lang, "heroOrdersNote")} />
          <HeroMetricCard label={t(lang, "incomeMetric")} value={hasAuth && summary ? `${formatAmount(summary.income)} ₽` : "—"} note={reportPeriodLabel} />
          <HeroMetricCard label={t(lang, "profitMetric")} value={hasAuth && summary ? `${formatAmount(summary.profit)} ₽` : "—"} note={t(lang, "heroProfitNote")} />
        </div>
      </header>

      {globalStatus ? <div className={`status-banner ${globalStatusKind}`}>{globalStatus}</div> : null}

      <section className="tabs-shell">
        <div className="tabs-content">
          {activeTabIndex === 0 ? (
            <SalesTab
              lang={lang}
              hasAuth={hasAuth}
              salesScreen={salesScreen}
              salesListMode={salesListMode}
              setSalesListMode={setSalesListMode}
              salesQuery={salesQuery}
              setSalesQuery={setSalesQuery}
              showOpenOrdersSearch={showOpenOrdersSearch}
              showClosedOrdersSearch={showClosedOrdersSearch}
              filteredOpenOrders={filteredOpenOrders}
              filteredClosedOrders={filteredClosedOrders}
              selectedOrderId={selectedOrderId}
              selectedOrder={selectedOrder}
              selectedOrderIsOpen={selectedOrderIsOpen}
              orderSection={orderSection}
              setOrderSection={setOrderSection}
              orderPurchaseOperations={orderPurchaseOperations}
              componentsCostTotal={componentsCostTotal}
              activeComponentDraft={activeComponentDraft}
              draftComponentActionId={draftComponentActionId}
              draftComponentCost={draftComponentCost}
              setDraftComponentCost={setDraftComponentCost}
              draftComponentSupplier={draftComponentSupplier}
              setDraftComponentSupplier={setDraftComponentSupplier}
              savingDraftComponentId={savingDraftComponentId}
              activeSaleDraft={activeSaleDraft}
              updateSaleDraft={updateSaleDraft}
              saleAmountValue={saleAmountValue}
              prepaymentAmountValue={prepaymentAmountValue}
              postpaymentAmountValue={postpaymentAmountValue}
              plannedPaidAmount={plannedPaidAmount}
              saleProfit={saleProfit}
              saleBalanceDue={saleBalanceDue}
              selectedOrderProfit={selectedOrderProfit}
              orderNextStep={orderNextStep}
              selectedOrderTimeline={selectedOrderTimeline}
              isOrderTimelineLoading={isOrderTimelineLoading}
              documents={documents}
              documentAssistById={documentAssistById}
              expandedDocumentAssistId={expandedDocumentAssistId}
              assistingDocumentId={assistingDocumentId}
              deletingOperationId={deletingOperationId}
              deletingOrderId={deletingOrderId}
              downloadingDocumentId={downloadingDocumentId}
              documentTypes={documentTypes}
              docType={docType}
              setDocType={setDocType}
              docFile={docFile}
              setDocFile={setDocFile}
              isOrdersLoading={isOrdersLoading}
              isDocumentsLoading={isDocumentsLoading}
              isAddingComponent={isAddingComponent}
              isCreatingOrder={isCreatingOrder}
              isFinalizingSale={isFinalizingSale}
              isUploadingDoc={isUploadingDoc}
              isExportingDocs={isExportingDocs}
              showSaleCloseConfirm={showSaleCloseConfirm}
              setShowSaleCloseConfirm={setShowSaleCloseConfirm}
              reopeningOrderId={reopeningOrderId}
              orderFilesCount={orderFilesCount}
              phone={phone}
              setPhone={setPhone}
              clientName={clientName}
              setClientName={setClientName}
              componentName={componentName}
              setComponentName={setComponentName}
              componentCost={componentCost}
              setComponentCost={setComponentCost}
              componentCostValue={componentCostValue}
              componentSupplier={componentSupplier}
              setComponentSupplier={setComponentSupplier}
              phoneValid={phoneValid}
              reopenedOrderIds={reopenedOrderIds}
              handleCreateOrder={handleCreateOrder}
              handleAddComponent={handleAddComponent}
              handlePrepareOrderFinalize={handlePrepareOrderFinalize}
              handleFinalizeSaleAndClose={handleFinalizeSaleAndClose}
              handleReopenOrder={handleReopenOrder}
              handleDeleteOrder={handleDeleteOrder}
              handleDeleteOperation={handleDeleteOperation}
              handleUploadDocument={handleUploadDocument}
              handleDownloadDocument={handleDownloadDocument}
              handleAssistDocument={handleAssistDocument}
              handleApplyAssistSale={handleApplyAssistSale}
              handleApplyAssistComponents={handleApplyAssistComponents}
              handleApplyAssistIdentity={handleApplyAssistIdentity}
              handleUseDraftComponent={handleUseDraftComponent}
              startDraftComponentQuickAdd={startDraftComponentQuickAdd}
              cancelDraftComponentQuickAdd={cancelDraftComponentQuickAdd}
              handleSaveDraftComponent={handleSaveDraftComponent}
              handleClearComponentDraft={handleClearComponentDraft}
              handleExportOrderDocuments={handleExportOrderDocuments}
              openSalesOrder={openSalesOrder}
              returnToSalesList={returnToSalesList}
            />
          ) : null}

          {activeTabIndex === 1 ? (
            <PurchasesTab
              lang={lang}
              hasAuth={hasAuth}
              expenseForm={expenseForm}
              setExpenseForm={setExpenseForm}
              expenseCategories={expenseCategories}
              paymentAccounts={paymentAccounts}
              paymentMethods={paymentMethods}
              expenseAmountValue={expenseAmountValue}
              isSavingExpense={isSavingExpense}
              businessExpenses={businessExpenses}
              businessExpensesTotal={businessExpensesTotal}
              isOperationsLoading={isOperationsLoading}
              deletingOperationId={deletingOperationId}
              handleSaveExpense={handleSaveExpense}
              startExpenseEdit={startExpenseEdit}
              resetExpenseForm={resetExpenseForm}
              handleDeleteOperation={handleDeleteOperation}
            />
          ) : null}

          {activeTabIndex === 2 ? (
            <StatsTab
              lang={lang}
              summary={summary}
              reportDays={reportDays}
              setReportDays={setReportDays}
              isReportsLoading={isReportsLoading}
              isOwner={isOwner}
              isBootstrapping={isBootstrapping}
              aiModelState={aiModelState}
              availableAiModels={availableAiModels}
              isUpdatingAiModel={isUpdatingAiModel}
              isSyncingSheets={isSyncingSheets}
              isExportingAllDocs={isExportingAllDocs}
              statsTotals={statsTotals}
              handleAiModelChange={handleAiModelChange}
              handleGoogleSheetsSync={handleGoogleSheetsSync}
              handleExportAllDocuments={handleExportAllDocuments}
            />
          ) : null}
        </div>

        <nav className="tabs-switcher bottom-tabs" role="tablist" aria-label={t(lang, "tabsAriaLabel")}>
          {tabItems.map((tab, index) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={activeTabIndex === index}
              className={activeTabIndex === index ? "tab-button active" : "tab-button"}
              onClick={() => setActiveTabIndex(index)}
            >
              <span className="tab-index">0{index + 1}</span>
              <span className="tab-label">{tab.label}</span>
            </button>
          ))}
        </nav>
      </section>
    </main>
  );
}
