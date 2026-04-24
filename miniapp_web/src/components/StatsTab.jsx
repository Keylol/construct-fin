import { useEffect, useRef } from "react";
import { t } from "../i18n";
import { formatAmount } from "../utils";

const CAT_COLORS = [
  "#01aeff", "#3b82f6", "#6366f1", "#8b5cf6",
  "#ec4899", "#f97316", "#f59e0b", "#10b981",
  "#0ea5e9", "#06b6d4", "#ef4444", "#64748b",
];

function DonutChart({ data }) {
  const canvasRef = useRef(null);
  const total = data.reduce((s, d) => s + d.amount, 0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width;
    const cx = W / 2;
    const cy = W / 2;
    const outerR = W / 2 - 4;
    const innerR = outerR * 0.58;

    ctx.clearRect(0, 0, W, W);

    if (total === 0) {
      ctx.beginPath();
      ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
      ctx.strokeStyle = "#d6deeb";
      ctx.lineWidth = outerR - innerR;
      ctx.stroke();
      return;
    }

    let startAngle = -Math.PI / 2;
    data.forEach((seg, i) => {
      const sweep = (seg.amount / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, outerR, startAngle, startAngle + sweep);
      ctx.closePath();
      ctx.fillStyle = CAT_COLORS[i % CAT_COLORS.length];
      ctx.fill();
      startAngle += sweep;
    });

    // inner circle cutout
    ctx.beginPath();
    ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
  }, [data, total]);

  return (
    <div className="donut-canvas-wrap">
      <canvas ref={canvasRef} width={160} height={160} />
      <div className="donut-center">
        <strong>{formatAmount(total)} ₽</strong>
        <span>расходы</span>
      </div>
    </div>
  );
}

function SectionTitle({ children }) {
  return <div className="stats-section-title">{children}</div>;
}

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
  catBreakdown,
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
        <div className="stats-kpi-grid">
          {Array.from({ length: 4 }).map((_, i) => (
            <div className="stats-kpi-card skeleton" key={i} style={{ minHeight: 80 }} />
          ))}
        </div>
      ) : summary ? (
        <>
          {/* KPI cards */}
          <SectionTitle>Ключевые показатели</SectionTitle>
          <div className="stats-kpi-grid">
            <div className="stats-kpi-card">
              <span className="stats-kpi-icon">💰</span>
              <span className="stats-kpi-label">{t(lang, "incomeMetric")}</span>
              <span className="stats-kpi-value">{formatAmount(summary.income)} ₽</span>
            </div>
            <div className="stats-kpi-card">
              <span className="stats-kpi-icon">📦</span>
              <span className="stats-kpi-label">{t(lang, "cogsMetric")}</span>
              <span className="stats-kpi-value">{formatAmount(summary.purchases)} ₽</span>
            </div>
            <div className="stats-kpi-card">
              <span className="stats-kpi-icon">🧾</span>
              <span className="stats-kpi-label">{t(lang, "otherExpensesMetric")}</span>
              <span className="stats-kpi-value">{formatAmount(summary.other_expenses)} ₽</span>
            </div>
            <div className="stats-kpi-card">
              <span className="stats-kpi-icon">{summary.profit >= 0 ? "📈" : "📉"}</span>
              <span className="stats-kpi-label">{t(lang, "profitMetric")}</span>
              <span className="stats-kpi-value" style={{ color: summary.profit < 0 ? "var(--danger)" : undefined }}>
                {formatAmount(summary.profit)} ₽
              </span>
            </div>
          </div>

          <div className="metrics-ribbon compact-inline-ribbon">
            <span>{t(lang, "openOrdersMetric")}: {summary.open_orders_count}</span>
            <span>{t(lang, "averageTicketMetric")}: {formatAmount(summary.average_ticket)} ₽</span>
          </div>

          {/* Bar chart */}
          <SectionTitle>Структура P&amp;L</SectionTitle>
          <section className="step-card stage-card stats-chart-card">
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
          </section>

          {/* Donut chart */}
          {catBreakdown && catBreakdown.length > 0 ? (
            <>
              <SectionTitle>Структура расходов</SectionTitle>
              <section className="step-card stage-card" style={{ padding: 16 }}>
                <div className="donut-section">
                  <div className="donut-wrap">
                    <DonutChart data={catBreakdown} />
                    <div className="donut-legend">
                      {catBreakdown.map((seg, i) => (
                        <div className="legend-item" key={seg.name}>
                          <span className="legend-dot" style={{ background: CAT_COLORS[i % CAT_COLORS.length] }} />
                          <span className="legend-name">{seg.name}</span>
                          <span className="legend-pct">{seg.pct.toFixed(0)}%</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <table className="cat-table">
                    <thead>
                      <tr>
                        <th>Категория</th>
                        <th style={{ textAlign: "right" }}>Сумма, ₽</th>
                        <th style={{ textAlign: "right" }}>Доля</th>
                      </tr>
                    </thead>
                    <tbody>
                      {catBreakdown.map((seg, i) => (
                        <tr key={seg.name}>
                          <td>
                            <span className="cat-dot" style={{ background: CAT_COLORS[i % CAT_COLORS.length] }} />
                            {seg.name}
                          </td>
                          <td>{formatAmount(seg.amount)}</td>
                          <td>{seg.pct.toFixed(1)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          ) : null}

          {/* Owner tools */}
          {isOwner ? (
            <>
              <SectionTitle>Инструменты</SectionTitle>
              <section className="step-card stage-card owner-tools-card">
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
            </>
          ) : null}
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
