import { t } from "../i18n";
import { formatAmount } from "../utils";

function SectionIntro({ title, actions }) {
  return (
    <div className="section-intro">
      <div className="section-intro-copy"><h2>{title}</h2></div>
      {actions ? <div className="section-intro-actions">{actions}</div> : null}
    </div>
  );
}

export function StatsTab({
  lang,
  summary,
  reportDays,
  setReportDays,
  isReportsLoading,
  isOwner,
  isBootstrapping,
  aiModelState,
  availableAiModels,
  isUpdatingAiModel,
  isSyncingSheets,
  isExportingAllDocs,
  statsTotals,
  handleAiModelChange,
  handleGoogleSheetsSync,
  handleExportAllDocuments,
}) {
  return (
    <section className="panel stats-panel premium-panel">
      <SectionIntro
        title={t(lang, "tabStats")}
        actions={
          <div className="period-switch">
            {[1, 7, 30].map((days) => (
              <button
                key={days}
                type="button"
                className={reportDays === days ? "small-button active-switch" : "small-button secondary"}
                onClick={() => setReportDays(days)}
              >
                {days === 1 ? t(lang, "periodToday") : days === 7 ? t(lang, "periodWeek") : t(lang, "periodMonth")}
              </button>
            ))}
          </div>
        }
      />

      {isReportsLoading ? (
        <div className="metrics-grid">
          {Array.from({ length: 4 }).map((_, i) => <article className="metric-card skeleton skeleton-card" key={i} />)}
        </div>
      ) : summary ? (
        <>
          <div className="metrics-grid">
            <article className="metric-card premium-metric-card">
              <span>{t(lang, "incomeMetric")}</span>
              <strong>{formatAmount(summary.income)} ₽</strong>
            </article>
            <article className="metric-card premium-metric-card">
              <span>{t(lang, "cogsMetric")}</span>
              <strong>{formatAmount(summary.purchases)} ₽</strong>
            </article>
            <article className="metric-card premium-metric-card">
              <span>{t(lang, "otherExpensesMetric")}</span>
              <strong>{formatAmount(summary.other_expenses)} ₽</strong>
            </article>
            <article className="metric-card premium-metric-card">
              <span>{t(lang, "profitMetric")}</span>
              <strong>{formatAmount(summary.profit)} ₽</strong>
            </article>
          </div>

          <div className="metrics-ribbon compact-inline-ribbon">
            <span>{t(lang, "openOrdersMetric")}: {summary.open_orders_count}</span>
            <span>{t(lang, "averageTicketMetric")}: {formatAmount(summary.average_ticket)} ₽</span>
          </div>

          {isOwner ? (
            <section className="step-card stage-card owner-tools-card">
              <div className="section-heading compact-heading">
                <h3>{t(lang, "ownerToolsTitle")}</h3>
              </div>
              <div className="owner-tools-grid">
                {availableAiModels.length ? (
                  <label className="owner-tool-field">
                    <span>{t(lang, "aiModelLabel")}</span>
                    <select
                      value={aiModelState?.active_model || ""}
                      onChange={handleAiModelChange}
                      disabled={isUpdatingAiModel || isBootstrapping}
                    >
                      {availableAiModels.map((item) => (
                        <option key={item} value={item}>{item}</option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <button
                  type="button"
                  className="small-button secondary"
                  onClick={handleGoogleSheetsSync}
                  disabled={isSyncingSheets || isBootstrapping}
                >
                  {isSyncingSheets ? t(lang, "sheetsSyncing") : t(lang, "sheetsSyncButton")}
                </button>
                <button
                  type="button"
                  className="small-button secondary"
                  onClick={handleExportAllDocuments}
                  disabled={isExportingAllDocs || isBootstrapping}
                >
                  {isExportingAllDocs ? t(lang, "exporting") : t(lang, "exportAllFiles")}
                </button>
              </div>
            </section>
          ) : null}

          <section className="stats-hero">
            <div className="stats-chart-card">
              <div className="compare-chart">
                {statsTotals.bars.map((item) => (
                  <div className="compare-chart-row" key={item.key}>
                    <div className="compare-chart-head">
                      <span>{t(lang, item.labelKey)}</span>
                      <strong>{formatAmount(item.value)} ₽</strong>
                    </div>
                    <div className="compare-chart-track">
                      <div
                        className={item.negative ? "compare-chart-fill is-loss" : `compare-chart-fill is-${item.key}`}
                        style={{ width: `${item.percent}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              {statsTotals.profit < 0 ? (
                <div className="helper-error">{t(lang, "negativeProfitHint")} {formatAmount(statsTotals.loss)} ₽</div>
              ) : null}
            </div>
          </section>
        </>
      ) : (
        <article className="item-card empty-state">
          <div className="empty-title">{t(lang, "reportsEmpty")}</div>
          <div className="empty-note">{t(lang, "statsSimpleHint")}</div>
        </article>
      )}
    </section>
  );
}
