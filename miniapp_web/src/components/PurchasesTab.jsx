import { t } from "../i18n";
import { formatAmount, normalizeAmountInput } from "../utils";

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
        <div className="items-grid">
          {!hasAuth ? (
            <div className="inline-empty-note">{t(lang, "signInToContinue")}</div>
          ) : isOperationsLoading ? (
            Array.from({ length: 4 }).map((_, i) => <article className="item-card skeleton skeleton-card" key={i} />)
          ) : businessExpenses.length === 0 ? (
            <div className="inline-empty-note">{t(lang, "noBusinessPurchases")}</div>
          ) : (
            businessExpenses.map((item) => (
              <article className="item-card purchase-record-card" key={item.id}>
                <strong>{item.expense_category || t(lang, "operationCategoryLabel")} · {formatAmount(item.amount)} ₽</strong>
                <div>{item.description}</div>
                <div className="meta">{item.date}{item.payment_account ? ` · ${item.payment_account}` : ""}</div>
                <div className="row-actions compact-row">
                  <button type="button" className="small-button secondary" onClick={() => startExpenseEdit(item)}>
                    {t(lang, "editOperation")}
                  </button>
                  <button
                    type="button"
                    className="small-button secondary danger-button"
                    onClick={() => handleDeleteOperation(item.id)}
                    disabled={deletingOperationId === item.id}
                  >
                    {deletingOperationId === item.id ? t(lang, "deleting") : t(lang, "deleteOperation")}
                  </button>
                </div>
              </article>
            ))
          )}
        </div>
      </section>
    </section>
  );
}
