import { t } from "../i18n";
import { formatAmount, normalizeAmountInput } from "../utils";

const CAT_COLORS = {
  "Аренда":               "#3b82f6",
  "Офис":                 "#8b5cf6",
  "Зарплатный фонд":      "#0ea5e9",
  "Внешние исполнители":  "#6366f1",
  "Интернет":             "#06b6d4",
  "Расходники":           "#64748b",
  "Реклама":              "#f59e0b",
  "Розыгрыши":            "#ec4899",
  "Доставка":             "#10b981",
  "Банковские расходы":   "#ef4444",
  "Налоги":               "#f97316",
  "Развитие бизнеса":     "#01aeff",
};

function catColor(cat) {
  return CAT_COLORS[cat] || "#94a3b8";
}

const RECEIPT_ACCEPT = "image/*,application/pdf,.pdf,.jpg,.jpeg,.png,.heic,.heif,.webp";

export function PurchasesTab({
  lang,
  hasAuth,
  expenseForm,
  setExpenseForm,
  expenseCategories,
  paymentAccounts,
  paymentMethods,
  expenseAmountValue,
  isSavingExpense,
  businessExpenses,
  businessExpensesTotal,
  isOperationsLoading,
  deletingOperationId,
  handleSaveExpense,
  startExpenseEdit,
  resetExpenseForm,
  handleDeleteOperation,
  handleOpenReceipt,
  handleDeleteReceipt,
}) {
  return (
    <section className="panel purchases-panel premium-panel">
      <div className="section-intro">
        <div className="section-intro-copy"><h2>{t(lang, "tabPurchases")}</h2></div>
      </div>

      <section className="step-card stage-card purchase-form-card">
        <div className="section-heading compact-heading">
          <h3>{expenseForm.id ? t(lang, "editOperation") : t(lang, "savePurchase")}</h3>
          {businessExpensesTotal > 0 ? (
            <div className="metrics-ribbon compact-inline-ribbon">
              <span>{formatAmount(businessExpensesTotal)} ₽</span>
            </div>
          ) : null}
        </div>
        <form onSubmit={handleSaveExpense}>
          <fieldset className="form-fieldset" disabled={!hasAuth || isSavingExpense}>
            <div className="form-grid form-grid-two">
              <div>
                <label>{t(lang, "operationCategoryLabel")}</label>
                <select
                  value={expenseForm.expense_category}
                  onChange={(e) => setExpenseForm((prev) => ({ ...prev, expense_category: e.target.value }))}
                >
                  <option value="">-</option>
                  {expenseCategories.map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
              </div>
              <div>
                <label>{t(lang, "operationAmountLabel")}</label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={expenseForm.amount}
                  onChange={(e) => setExpenseForm((prev) => ({ ...prev, amount: normalizeAmountInput(e.target.value) }))}
                />
              </div>
            </div>

            <label>{t(lang, "operationDescriptionLabel")}</label>
            <textarea
              rows={3}
              value={expenseForm.description}
              onChange={(e) => setExpenseForm((prev) => ({ ...prev, description: e.target.value }))}
              placeholder={t(lang, "operationCommentPlaceholder")}
            />

            <div className="form-grid form-grid-three">
              <div>
                <label>{t(lang, "operationDateLabel")}</label>
                <input
                  type="date"
                  value={expenseForm.date}
                  onChange={(e) => setExpenseForm((prev) => ({ ...prev, date: e.target.value }))}
                />
              </div>
              <div>
                <label>{t(lang, "operationAccountLabel")}</label>
                <select
                  value={expenseForm.payment_account}
                  onChange={(e) => setExpenseForm((prev) => ({ ...prev, payment_account: e.target.value }))}
                >
                  <option value="">-</option>
                  {paymentAccounts.map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
              </div>
              <div>
                <label>{t(lang, "operationMethodLabel")}</label>
                <select
                  value={expenseForm.payment_method}
                  onChange={(e) => setExpenseForm((prev) => ({ ...prev, payment_method: e.target.value }))}
                >
                  <option value="">-</option>
                  {paymentMethods.map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label>{t(lang, "receiptLabel")}</label>
              <input
                type="file"
                accept={RECEIPT_ACCEPT}
                capture="environment"
                onChange={(e) => {
                  const file = e.target.files && e.target.files[0] ? e.target.files[0] : null;
                  setExpenseForm((prev) => ({ ...prev, receipt_file: file }));
                }}
              />
              {expenseForm.receipt_file ? (
                <div className="meta">
                  {expenseForm.receipt_file.name} ·
                  {" "}
                  {(expenseForm.receipt_file.size / 1024 / 1024).toFixed(2)} MB
                </div>
              ) : expenseForm.has_receipt ? (
                <div className="meta">
                  {t(lang, "receiptCurrent")}
                  {handleOpenReceipt && expenseForm.id ? (
                    <>
                      {" · "}
                      <button
                        type="button"
                        className="small-button secondary"
                        onClick={() => handleOpenReceipt(expenseForm.id)}
                      >
                        {t(lang, "receiptOpen")}
                      </button>
                    </>
                  ) : null}
                  {handleDeleteReceipt && expenseForm.id ? (
                    <>
                      {" · "}
                      <button
                        type="button"
                        className="small-button secondary danger-button"
                        onClick={() => handleDeleteReceipt(expenseForm.id)}
                      >
                        {t(lang, "receiptRemove")}
                      </button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="row-actions">
              <button
                type="submit"
                disabled={!expenseForm.expense_category || expenseAmountValue <= 0 || !expenseForm.description.trim()}
              >
                {isSavingExpense ? t(lang, "saving") : expenseForm.id ? t(lang, "saveChanges") : t(lang, "savePurchase")}
              </button>
              {expenseForm.id ? (
                <button type="button" className="secondary" onClick={resetExpenseForm} disabled={isSavingExpense}>
                  {t(lang, "cancelButton")}
                </button>
              ) : null}
            </div>
          </fieldset>
        </form>
      </section>

      <section className="step-card stage-card">
        <div className="section-heading compact-heading">
          <h3>{t(lang, "recentPurchasesTitle")}</h3>
        </div>
        {!hasAuth ? (
          <div className="inline-empty-note">{t(lang, "signInToContinue")}</div>
        ) : isOperationsLoading ? (
          <div className="expense-list">
            {Array.from({ length: 4 }).map((_, i) => (
              <div className="expense-row skeleton" key={i} style={{ minHeight: 44 }} />
            ))}
          </div>
        ) : businessExpenses.length === 0 ? (
          <div className="inline-empty-note">{t(lang, "noBusinessPurchases")}</div>
        ) : (
          <div className="expense-list">
            {businessExpenses.map((item) => (
              <div className="expense-row" key={item.id}>
                <div className="expense-row-main">
                  <span className="expense-date">{item.date}</span>
                  {item.expense_category ? (
                    <span
                      className="expense-cat-badge"
                      style={{ background: catColor(item.expense_category) }}
                    >
                      {item.expense_category}
                    </span>
                  ) : null}
                  <span className="expense-desc">{item.description}</span>
                  <span className="expense-amount">
                    {formatAmount(item.amount)} ₽
                    {item.has_receipt ? <span className="expense-receipt-icon" title={t(lang, "receiptAttachedBadge")}>🧾</span> : null}
                  </span>
                </div>
                <div className="expense-row-actions compact-row">
                  <button type="button" className="small-button secondary" onClick={() => startExpenseEdit(item)}>
                    {t(lang, "editOperation")}
                  </button>
                  {item.has_receipt && handleOpenReceipt ? (
                    <button type="button" className="small-button secondary" onClick={() => handleOpenReceipt(item.id)}>
                      {t(lang, "receiptOpen")}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="small-button secondary danger-button"
                    onClick={() => handleDeleteOperation(item.id)}
                    disabled={deletingOperationId === item.id}
                  >
                    {deletingOperationId === item.id ? t(lang, "deleting") : t(lang, "deleteOperation")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}
