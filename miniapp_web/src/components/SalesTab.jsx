import { t } from "../i18n";
import { SUPPLIER_CHOICES, formatAmount, formatDateTime, formatFileSize, normalizeAmountInput, normalizePhone } from "../utils";

function SectionIntro({ title, actions }) {
  return (
    <div className="section-intro">
      <div className="section-intro-copy"><h2>{title}</h2></div>
      {actions ? <div className="section-intro-actions">{actions}</div> : null}
    </div>
  );
}

export function SalesTab({
  lang,
  hasAuth,
  salesScreen,
  salesListMode,
  setSalesListMode,
  salesQuery,
  setSalesQuery,
  showOpenOrdersSearch,
  showClosedOrdersSearch,
  filteredOpenOrders,
  filteredClosedOrders,
  selectedOrderId,
  selectedOrder,
  selectedOrderIsOpen,
  orderSection,
  setOrderSection,
  orderPurchaseOperations,
  componentsCostTotal,
  activeComponentDraft,
  draftComponentActionId,
  draftComponentCost,
  setDraftComponentCost,
  draftComponentSupplier,
  setDraftComponentSupplier,
  savingDraftComponentId,
  activeSaleDraft,
  updateSaleDraft,
  saleAmountValue,
  prepaymentAmountValue,
  postpaymentAmountValue,
  plannedPaidAmount,
  saleProfit,
  saleBalanceDue,
  selectedOrderProfit,
  orderNextStep,
  selectedOrderTimeline,
  isOrderTimelineLoading,
  documents,
  documentAssistById,
  expandedDocumentAssistId,
  assistingDocumentId,
  deletingOperationId,
  deletingOrderId,
  downloadingDocumentId,
  documentTypes,
  docType,
  setDocType,
  docFile,
  setDocFile,
  isOrdersLoading,
  isDocumentsLoading,
  isAddingComponent,
  isCreatingOrder,
  isFinalizingSale,
  isUploadingDoc,
  isExportingDocs,
  showSaleCloseConfirm,
  setShowSaleCloseConfirm,
  reopeningOrderId,
  orderFilesCount,
  phone,
  setPhone,
  clientName,
  setClientName,
  componentName,
  setComponentName,
  componentCost,
  setComponentCost,
  componentCostValue,
  componentSupplier,
  setComponentSupplier,
  phoneValid,
  isPhoneValidFn,
  reopenedOrderIds,
  handleCreateOrder,
  handleAddComponent,
  handlePrepareOrderFinalize,
  handleFinalizeSaleAndClose,
  handleReopenOrder,
  handleDeleteOrder,
  handleDeleteOperation,
  handleUploadDocument,
  handleDownloadDocument,
  handleAssistDocument,
  handleApplyAssistSale,
  handleApplyAssistComponents,
  handleApplyAssistIdentity,
  handleUseDraftComponent,
  startDraftComponentQuickAdd,
  cancelDraftComponentQuickAdd,
  handleSaveDraftComponent,
  handleClearComponentDraft,
  handleExportOrderDocuments,
  openSalesOrder,
  returnToSalesList,
}) {
  return (
    <section className="panel sales-panel premium-panel">
      <SectionIntro
        title={t(lang, "tabSales")}
        actions={
          salesScreen === "order" && selectedOrder ? (
            <button type="button" className="small-button secondary" onClick={returnToSalesList}>
              {t(lang, "backToOrders")}
            </button>
          ) : (
            <div className="sales-mode-switch">
              {["create", "active", "history"].map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={salesListMode === mode ? "small-button active-switch" : "small-button secondary"}
                  onClick={() => setSalesListMode(mode)}
                >
                  {mode === "create" ? t(lang, "showCreateOrder") : mode === "active" ? t(lang, "openOrdersLabel") : t(lang, "showHistory")}
                </button>
              ))}
            </div>
          )
        }
      />

      {salesScreen === "list" ? (
        <div className="sales-list-view">
          {(showOpenOrdersSearch || showClosedOrdersSearch) ? (
            <div className="sales-search-row">
              <input
                type="search"
                value={salesQuery}
                onChange={(e) => setSalesQuery(e.target.value)}
                placeholder={t(lang, "salesSearchPlaceholder")}
              />
            </div>
          ) : null}

          {salesListMode === "create" ? (
            <section className="step-card compact-section sales-mode-panel">
              <form onSubmit={handleCreateOrder}>
                <fieldset className="form-fieldset" disabled={!hasAuth || isCreatingOrder}>
                  <div className="form-grid form-grid-two">
                    <div>
                      <label>{t(lang, "phoneLabel")}</label>
                      <input
                        required
                        value={phone}
                        onChange={(e) => setPhone(normalizePhone(e.target.value))}
                        placeholder={t(lang, "phonePlaceholder")}
                        className={phone && !phoneValid ? "input-invalid" : ""}
                      />
                      {phone && !phoneValid ? <div className="helper-error">{t(lang, "phoneInvalidHint")}</div> : null}
                    </div>
                    <div>
                      <label>{t(lang, "nameLabel")}</label>
                      <input value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="Иванов Иван" />
                    </div>
                  </div>
                  <div className="row-actions">
                    <button type="submit" disabled={!phoneValid}>
                      {isCreatingOrder ? t(lang, "creating") : t(lang, "createOrder")}
                    </button>
                    {filteredOpenOrders.length > 0 ? (
                      <button type="button" className="secondary" onClick={() => setSalesListMode("active")}>
                        {t(lang, "openOrdersShortcut", { count: filteredOpenOrders.length })}
                      </button>
                    ) : null}
                  </div>
                </fieldset>
              </form>
            </section>
          ) : null}

          {salesListMode === "active" ? (
            <section className="step-card compact-section sales-mode-panel">
              <div className="items-grid order-list-grid">
                {!hasAuth ? (
                  <div className="inline-empty-note">{t(lang, "signInToContinue")}</div>
                ) : isOrdersLoading ? (
                  Array.from({ length: 3 }).map((_, i) => <article className="item-card skeleton skeleton-card" key={i} />)
                ) : filteredOpenOrders.length === 0 ? (
                  <div className="inline-empty-note">{salesQuery ? t(lang, "salesSearchEmpty") : t(lang, "noOpenOrders")}</div>
                ) : (
                  filteredOpenOrders.map((order) => (
                    <article
                      key={order.id}
                      className={selectedOrderId === String(order.id) ? "item-card active-order-card order-card-premium" : "item-card order-card-premium"}
                    >
                      <h4>{order.client_name || t(lang, "clientWithoutName")}</h4>
                      <div className="order-card-phone">{order.order_phone}</div>
                      <div className="row-actions compact-row">
                        <button type="button" className="small-button" onClick={() => openSalesOrder(order.id)}>
                          {t(lang, "openOrder")}
                        </button>
                      </div>
                    </article>
                  ))
                )}
              </div>
            </section>
          ) : null}

          {salesListMode === "history" ? (
            <section className="step-card compact-section sales-mode-panel">
              <div className="items-grid order-list-grid">
                {filteredClosedOrders.length === 0 ? (
                  <div className="inline-empty-note">{salesQuery ? t(lang, "salesSearchEmpty") : t(lang, "noClosedOrders")}</div>
                ) : (
                  filteredClosedOrders.map((order) => (
                    <article
                      key={order.id}
                      className={selectedOrderId === String(order.id) ? "item-card active-order-card order-card-premium" : "item-card order-card-premium"}
                    >
                      <h4>{order.client_name || t(lang, "clientWithoutName")}</h4>
                      <div className="order-card-phone">{order.order_phone}</div>
                      <div className="row-actions compact-row">
                        <button type="button" className="small-button secondary" onClick={() => openSalesOrder(order.id)}>
                          {t(lang, "openOrder")}
                        </button>
                        <button
                          type="button"
                          className="small-button secondary"
                          onClick={() => handleReopenOrder(order.id)}
                          disabled={reopeningOrderId === order.id}
                        >
                          {reopeningOrderId === order.id ? t(lang, "checking") : t(lang, "reopenOrder")}
                        </button>
                      </div>
                    </article>
                  ))
                )}
              </div>
            </section>
          ) : null}
        </div>
      ) : selectedOrder ? (
        <section className="sales-detail-view">
          <article className="order-hero-shell order-shell-compact">
            <div className="order-shell-topline">
              <div className="order-hero-copy">
                <h3>{selectedOrder.client_name || t(lang, "clientWithoutName")}</h3>
                <p>#{selectedOrder.id} · {selectedOrder.order_phone}</p>
              </div>
              <div className="row-actions compact-row wrap-actions">
                {!selectedOrderIsOpen ? (
                  <button
                    type="button"
                    className="small-button secondary"
                    onClick={() => handleReopenOrder(selectedOrder.id)}
                    disabled={reopeningOrderId === selectedOrder.id}
                  >
                    {reopeningOrderId === selectedOrder.id ? t(lang, "checking") : t(lang, "reopenOrder")}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="small-button secondary"
                  onClick={handleExportOrderDocuments}
                  disabled={isExportingDocs || orderFilesCount === 0}
                >
                  {isExportingDocs ? t(lang, "exporting") : t(lang, "exportOrderFiles")}
                </button>
                <button
                  type="button"
                  className="small-button danger-button"
                  onClick={() => handleDeleteOrder(selectedOrder.id)}
                  disabled={deletingOrderId === selectedOrder.id}
                >
                  {deletingOrderId === selectedOrder.id ? t(lang, "deleting") : t(lang, "deleteOrder")}
                </button>
              </div>
            </div>

            <div className="order-summary-strip">
              <article className="order-summary-card">
                <span>{t(lang, "profitPreviewLabel")}</span>
                <strong>{formatAmount(selectedOrderProfit || saleProfit)} ₽</strong>
              </article>
              <article className="order-summary-card">
                <span>{t(lang, "saleTotalLabel")}</span>
                <strong>{formatAmount(selectedOrder.sale_amount || saleAmountValue)} ₽</strong>
              </article>
              <article className="order-summary-card">
                <span>{t(lang, "balanceDueMetric")}</span>
                <strong>{formatAmount(selectedOrder.balance_due || saleBalanceDue)} ₽</strong>
              </article>
            </div>

            {orderNextStep ? (
              <div className={orderNextStep.done ? "soft-note order-next-step is-done" : "soft-note order-next-step"}>
                <div className="order-next-step-copy">
                  <span>{t(lang, "nextStepLabel")}</span>
                  <strong>{orderNextStep.title}</strong>
                </div>
                {orderSection !== orderNextStep.section ? (
                  <button type="button" className="small-button secondary" onClick={() => setOrderSection(orderNextStep.section)}>
                    {orderNextStep.actionLabel}
                  </button>
                ) : null}
              </div>
            ) : null}

            <div className="order-section-tabs order-section-tabs-compact">
              {[
                { key: "components", label: `1. ${t(lang, "orderTabComponents")}` },
                { key: "sale", label: `2. ${t(lang, "orderTabSale")}` },
                { key: "files", label: `3. ${t(lang, "orderTabFiles")}` },
                { key: "timeline", label: t(lang, "orderTabTimeline") },
              ].map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={orderSection === item.key ? "small-button active-switch" : "small-button secondary"}
                  onClick={() => setOrderSection(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </article>

          {orderSection === "components" ? (
            <section className="step-card compact-section stage-card">
              <div className="compact-section-head">
                <div><h3>{t(lang, "salesComponentsTitle")}</h3></div>
                <div className="order-mini-metrics">
                  <span>{orderPurchaseOperations.length} · {formatAmount(componentsCostTotal)} ₽</span>
                </div>
              </div>
              {activeComponentDraft.length ? (
                <div className="component-draft-card">
                  <div className="compact-section-head">
                    <div><h4>{t(lang, "componentDraftTitle")}</h4></div>
                    <div className="row-actions compact-row">
                      <button type="button" className="small-button secondary" onClick={handleClearComponentDraft}>
                        {t(lang, "clearDraft")}
                      </button>
                    </div>
                  </div>
                  <div className="items-grid">
                    {activeComponentDraft.map((item) => (
                      <article className="item-card order-detail-card draft-component-card" key={item.id}>
                        <div>
                          <strong>{item.component_name}</strong>
                          <div>{item.component_value}</div>
                          {item.confidence ? (
                            <div className="meta">{t(lang, "assistConfidenceLabel")}: {Math.round(Number(item.confidence || 0) * 100)}%</div>
                          ) : null}
                        </div>
                        <div className="row-actions compact-row">
                          <button type="button" className="small-button secondary" onClick={() => startDraftComponentQuickAdd(item.id)}>
                            {t(lang, "draftAddDirect")}
                          </button>
                          <button type="button" className="small-button secondary" onClick={() => handleUseDraftComponent(item.id)}>
                            {t(lang, "draftUseInForm")}
                          </button>
                        </div>
                        {draftComponentActionId === item.id ? (
                          <div className="draft-quick-add">
                            <div className="form-grid form-grid-two">
                              <div>
                                <label>{t(lang, "componentCostLabel")}</label>
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  value={draftComponentCost}
                                  onChange={(e) => setDraftComponentCost(normalizeAmountInput(e.target.value))}
                                  placeholder="42000"
                                />
                              </div>
                              <div>
                                <label>{t(lang, "componentSupplierLabel")}</label>
                                <input
                                  list="supplier-choices"
                                  value={draftComponentSupplier}
                                  onChange={(e) => setDraftComponentSupplier(e.target.value)}
                                  placeholder="DNS / WB / Online Trade"
                                />
                              </div>
                            </div>
                            <div className="row-actions compact-row">
                              <button
                                type="button"
                                className="small-button secondary"
                                onClick={() => handleSaveDraftComponent(item.id)}
                                disabled={savingDraftComponentId === item.id}
                              >
                                {savingDraftComponentId === item.id ? t(lang, "saving") : t(lang, "draftConfirmAdd")}
                              </button>
                              <button
                                type="button"
                                className="small-button secondary"
                                onClick={cancelDraftComponentQuickAdd}
                                disabled={savingDraftComponentId === item.id}
                              >
                                {t(lang, "cancelButton")}
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </article>
                    ))}
                  </div>
                </div>
              ) : null}
              <form onSubmit={handleAddComponent}>
                <fieldset className="form-fieldset" disabled={!selectedOrderIsOpen || isAddingComponent}>
                  <div className="form-grid form-grid-three">
                    <div>
                      <label>{t(lang, "componentNameLabel")}</label>
                      <input
                        value={componentName}
                        onChange={(e) => setComponentName(e.target.value)}
                        placeholder="RTX 4070 / Ryzen 5 / SSD 1TB"
                      />
                    </div>
                    <div>
                      <label>{t(lang, "componentCostLabel")}</label>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={componentCost}
                        onChange={(e) => setComponentCost(normalizeAmountInput(e.target.value))}
                        placeholder="42000"
                      />
                    </div>
                    <div>
                      <label>{t(lang, "componentSupplierLabel")}</label>
                      <input
                        list="supplier-choices"
                        value={componentSupplier}
                        onChange={(e) => setComponentSupplier(e.target.value)}
                        placeholder="DNS / WB / Online Trade"
                      />
                    </div>
                  </div>
                  <datalist id="supplier-choices">
                    {SUPPLIER_CHOICES.map((item) => <option key={item} value={item} />)}
                  </datalist>
                  <div className="row-actions">
                    <button type="submit" disabled={!componentName.trim() || componentCostValue <= 0}>
                      {isAddingComponent ? t(lang, "saving") : t(lang, "addComponentButton")}
                    </button>
                  </div>
                </fieldset>
              </form>
              <div className="items-grid">
                {orderPurchaseOperations.length === 0 ? (
                  <article className="item-card empty-state">
                    <div className="empty-title">{t(lang, "addComponentsFirst")}</div>
                    <div className="empty-note">{t(lang, "salesComponentsHint")}</div>
                  </article>
                ) : (
                  orderPurchaseOperations.map((item) => (
                    <article className="item-card order-detail-card" key={item.id}>
                      <strong>{item.description.replace(/^Изменение:\s*/i, "")}</strong>
                      <div className="meta">{formatAmount(item.amount)} ₽{item.supplier ? ` · ${item.supplier}` : ""}</div>
                      <div className="row-actions compact-row">
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
          ) : null}

          {orderSection === "sale" ? (
            <section className="step-card compact-section stage-card">
              <div className="compact-section-head">
                <div><h3>{t(lang, "salesFinalizeTitle")}</h3></div>
                <div className="order-mini-metrics">
                  <span>{t(lang, "profitPreviewLabel")}: {formatAmount(saleProfit)} ₽</span>
                </div>
              </div>
              <fieldset className="form-fieldset" disabled={!selectedOrderIsOpen || isFinalizingSale}>
                <div className="form-grid form-grid-three">
                  <div>
                    <label>{t(lang, "saleTotalLabel")}</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={activeSaleDraft.saleAmount}
                      onChange={(e) => updateSaleDraft((d) => ({ ...d, saleAmount: normalizeAmountInput(e.target.value) }))}
                      placeholder="99000"
                    />
                  </div>
                  <div className="payment-toggle-card">
                    <label className="checkbox-line">
                      <input
                        type="checkbox"
                        checked={Boolean(activeSaleDraft.usePrepayment)}
                        onChange={(e) => updateSaleDraft((d) => ({ ...d, usePrepayment: e.target.checked }))}
                      />
                      <span>{t(lang, "usePrepaymentLabel")}</span>
                    </label>
                    {activeSaleDraft.usePrepayment ? (
                      <input
                        type="text"
                        inputMode="decimal"
                        value={activeSaleDraft.prepaymentAmount}
                        onChange={(e) => updateSaleDraft((d) => ({ ...d, prepaymentAmount: normalizeAmountInput(e.target.value) }))}
                        placeholder="30000"
                      />
                    ) : null}
                  </div>
                  <div className="payment-toggle-card">
                    <label className="checkbox-line">
                      <input
                        type="checkbox"
                        checked={Boolean(activeSaleDraft.usePostpayment)}
                        onChange={(e) => updateSaleDraft((d) => ({ ...d, usePostpayment: e.target.checked }))}
                      />
                      <span>{t(lang, "usePostpaymentLabel")}</span>
                    </label>
                    {activeSaleDraft.usePostpayment ? (
                      <input
                        type="text"
                        inputMode="decimal"
                        value={activeSaleDraft.postpaymentAmount}
                        onChange={(e) => updateSaleDraft((d) => ({ ...d, postpaymentAmount: normalizeAmountInput(e.target.value) }))}
                        placeholder="69000"
                      />
                    ) : null}
                  </div>
                </div>
                <div className="metrics-ribbon">
                  <span>{t(lang, "componentsTotalLabel")}: {formatAmount(componentsCostTotal)} ₽</span>
                  <span>{t(lang, "paidTotalLabel")}: {formatAmount(plannedPaidAmount)} ₽</span>
                  <span>{t(lang, "balanceDueMetric")}: {formatAmount(saleBalanceDue)} ₽</span>
                </div>
                <button type="button" onClick={handlePrepareOrderFinalize}>
                  {t(lang, "openCloseSummary")}
                </button>
              </fieldset>
            </section>
          ) : null}

          {orderSection === "files" ? (
            <section className="step-card compact-section stage-card">
              <div className="compact-section-head">
                <div><h3>{t(lang, "orderFilesTitle")}</h3></div>
                <div className="row-actions compact-row">
                  <button
                    type="button"
                    className="small-button secondary"
                    onClick={handleExportOrderDocuments}
                    disabled={isExportingDocs || documents.length === 0}
                  >
                    {isExportingDocs ? t(lang, "exporting") : t(lang, "exportOrderFiles")}
                  </button>
                </div>
              </div>
              <form onSubmit={handleUploadDocument}>
                <fieldset className="form-fieldset" disabled={!selectedOrderId || isUploadingDoc}>
                  <div className="form-grid form-grid-two">
                    <div>
                      <label>{t(lang, "documentTypeLabel")}</label>
                      <select value={docType} onChange={(e) => setDocType(e.target.value)}>
                        {documentTypes.map((item) => <option key={item} value={item}>{item}</option>)}
                      </select>
                    </div>
                    <div>
                      <label>{t(lang, "documentFileLabel")}</label>
                      <input type="file" accept=".pdf,.doc,.docx" onChange={(e) => setDocFile(e.target.files?.[0] || null)} />
                    </div>
                  </div>
                  <div className="helper-note">{t(lang, "docsFormatHint")}</div>
                  {docFile ? <div className="file-chip">{t(lang, "selectedFile")}: {docFile.name} ({formatFileSize(docFile.size)})</div> : null}
                  <div className="row-actions">
                    <button type="submit" disabled={!docFile}>
                      {isUploadingDoc ? t(lang, "uploading") : t(lang, "uploadButton")}
                    </button>
                  </div>
                </fieldset>
              </form>
              <div className="items-grid">
                {isDocumentsLoading ? (
                  Array.from({ length: 2 }).map((_, i) => <article className="item-card skeleton skeleton-card" key={i} />)
                ) : documents.length === 0 ? (
                  <article className="item-card empty-state">
                    <div className="empty-title">{t(lang, "noDocuments")}</div>
                    <div className="empty-note">{t(lang, "docsEmptyHint")}</div>
                  </article>
                ) : (
                  documents.map((item) => (
                    <article className="item-card compact-file-card" key={item.id}>
                      <div>
                        <strong>{item.doc_type}</strong>
                        <div>{item.file_name}</div>
                        <div className="meta">{formatDateTime(item.uploaded_at)}</div>
                      </div>
                      <div className="row-actions compact-row">
                        {documentAssistById[item.id]?.parsed_items?.length ? (
                          <button type="button" className="small-button secondary" onClick={() => handleApplyAssistComponents(item.id)}>
                            {t(lang, "assistApplyComponents")}
                          </button>
                        ) : null}
                        {(documentAssistById[item.id]?.customer_name || documentAssistById[item.id]?.order_phone) ? (
                          <button type="button" className="small-button secondary" onClick={() => handleApplyAssistIdentity(item.id)}>
                            {t(lang, "assistApplyClient")}
                          </button>
                        ) : null}
                        {documentAssistById[item.id]?.customer_total ? (
                          <button type="button" className="small-button secondary" onClick={() => handleApplyAssistSale(item.id)}>
                            {t(lang, "assistApplySale")}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="small-button secondary"
                          onClick={() => handleAssistDocument(item.id)}
                          disabled={assistingDocumentId === item.id}
                        >
                          {assistingDocumentId === item.id
                            ? t(lang, "assistLoading")
                            : expandedDocumentAssistId === item.id
                              ? t(lang, "assistHide")
                              : t(lang, "assistDocument")}
                        </button>
                        <button
                          type="button"
                          className="small-button secondary"
                          onClick={() => handleDownloadDocument(item.id)}
                          disabled={downloadingDocumentId === item.id}
                        >
                          {downloadingDocumentId === item.id ? t(lang, "downloading") : t(lang, "downloadDocument")}
                        </button>
                      </div>
                      {expandedDocumentAssistId === item.id && documentAssistById[item.id] ? (
                        <div className="document-assist-card">
                          <div className="document-assist-head">
                            <strong>{documentAssistById[item.id].title}</strong>
                            {documentAssistById[item.id].confidence ? (
                              <span className="neutral-chip">
                                {t(lang, "assistConfidenceLabel")}: {Math.round(Number(documentAssistById[item.id].confidence || 0) * 100)}%
                              </span>
                            ) : null}
                          </div>
                          <div className="meta">{documentAssistById[item.id].summary}</div>
                          {documentAssistById[item.id].highlights?.length ? (
                            <div className="assist-chip-row">
                              {documentAssistById[item.id].highlights.map((line) => (
                                <span className="neutral-chip" key={line}>{line}</span>
                              ))}
                            </div>
                          ) : null}
                          {documentAssistById[item.id].customer_total || documentAssistById[item.id].customer_name || documentAssistById[item.id].order_phone ? (
                            <div className="assist-meta-row">
                              {documentAssistById[item.id].customer_total ? (
                                <span className="assist-meta-chip">{t(lang, "assistAmountLabel")}: {formatAmount(documentAssistById[item.id].customer_total)} ₽</span>
                              ) : null}
                              {documentAssistById[item.id].customer_name ? (
                                <span className="assist-meta-chip">{t(lang, "assistClientLabel")}: {documentAssistById[item.id].customer_name}</span>
                              ) : null}
                              {documentAssistById[item.id].order_phone ? (
                                <span className="assist-meta-chip">{t(lang, "assistPhoneLabel")}: {documentAssistById[item.id].order_phone}</span>
                              ) : null}
                            </div>
                          ) : null}
                          {documentAssistById[item.id].items_preview?.length ? (
                            <div className="assist-block">
                              <div className="assist-caption">{t(lang, "assistItemsLabel")}</div>
                              <ul className="assist-list">
                                {documentAssistById[item.id].items_preview.map((line) => <li key={line}>{line}</li>)}
                              </ul>
                            </div>
                          ) : null}
                          {documentAssistById[item.id].suggested_actions?.length ? (
                            <div className="assist-block">
                              <div className="assist-caption">{t(lang, "assistActionsLabel")}</div>
                              <ul className="assist-list">
                                {documentAssistById[item.id].suggested_actions.map((line) => <li key={line}>{line}</li>)}
                              </ul>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </article>
                  ))
                )}
              </div>
            </section>
          ) : null}

          {orderSection === "timeline" ? (
            <section className="step-card compact-section stage-card details-card">
              <div className="compact-section-head">
                <div><h3>{t(lang, "orderTimelineTitle")}</h3></div>
              </div>
              <div className="timeline-list">
                {isOrderTimelineLoading ? (
                  Array.from({ length: 3 }).map((_, i) => <article className="timeline-item skeleton skeleton-card" key={i} />)
                ) : selectedOrderTimeline.length === 0 ? (
                  <article className="item-card empty-state">
                    <div className="empty-title">{t(lang, "orderTimelineEmpty")}</div>
                    <div className="empty-note">{t(lang, "orderTimelineHint")}</div>
                  </article>
                ) : (
                  selectedOrderTimeline.map((item) => (
                    <article className={`timeline-item tone-${item.tone}`} key={item.id}>
                      <div className="timeline-main">
                        <strong>{item.title}</strong>
                        <div>{item.subtitle}</div>
                        <div className="meta">{item.meta}</div>
                      </div>
                      <div className="timeline-side">
                        {item.amount ? <div className="timeline-amount">{item.amount}</div> : null}
                        {item.operationId ? (
                          <button
                            type="button"
                            className="small-button secondary danger-button"
                            onClick={() => handleDeleteOperation(item.operationId)}
                            disabled={deletingOperationId === item.operationId}
                          >
                            {deletingOperationId === item.operationId ? t(lang, "deleting") : t(lang, "deleteOperation")}
                          </button>
                        ) : null}
                      </div>
                    </article>
                  ))
                )}
              </div>
            </section>
          ) : null}

          {showSaleCloseConfirm ? (
            <div className="preview-card confirm-card">
              <div className="section-kicker">{t(lang, "closeConfirmTitle")}</div>
              <strong>{t(lang, "closeConfirmTitle")}</strong>
              <div className="meta">{t(lang, "closeConfirmHint")}</div>
              <div className="confirm-grid">
                <div>{t(lang, "componentsTotalLabel")}: {formatAmount(componentsCostTotal)} ₽</div>
                <div>{t(lang, "saleTotalLabel")}: {formatAmount(saleAmountValue)} ₽</div>
                <div>{t(lang, "paidTotalLabel")}: {formatAmount(plannedPaidAmount)} ₽</div>
                <div>{t(lang, "profitPreviewLabel")}: {formatAmount(saleProfit)} ₽</div>
                <div>{t(lang, "balanceDueMetric")}: {formatAmount(saleBalanceDue)} ₽</div>
              </div>
              <div className="row-actions">
                <button type="button" onClick={handleFinalizeSaleAndClose} disabled={isFinalizingSale}>
                  {isFinalizingSale
                    ? t(lang, "saving")
                    : plannedPaidAmount + 0.01 < saleAmountValue
                      ? t(lang, "confirmSaveOpen")
                      : t(lang, "confirmCloseOrder")}
                </button>
                <button type="button" className="secondary" onClick={() => setShowSaleCloseConfirm(false)} disabled={isFinalizingSale}>
                  {t(lang, "cancelButton")}
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : (
        <article className="item-card empty-state">
          <div className="empty-title">{t(lang, "selectOrderForSale")}</div>
          <div className="empty-note">{t(lang, "salesWorkspaceHint")}</div>
        </article>
      )}
    </section>
  );
}
