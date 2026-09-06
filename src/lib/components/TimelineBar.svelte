<script lang="ts">
  let {
    workPercent = 0,
    personalPercent = 0,
    unclassifiedPercent = 0,
    height = '10px',
    showLabels = true,
    hourlyData
  } = $props<{
    workPercent?: number;
    personalPercent?: number;
    unclassifiedPercent?: number;
    height?: string;
    showLabels?: boolean;
    hourlyData?: Array<{ hour: number; minutes: number; label?: string }>;
  }>();
</script>

{#if hourlyData && hourlyData.length > 0}
  {@const maxMins = Math.max(...hourlyData.map((d: { hour: number; minutes: number; label?: string }) => d.minutes), 1)}
  <div class="hourly-timeline">
    <div class="timeline-strip" style="height: 52px;">
      {#each hourlyData as slot}
        {@const pct = Math.min(100, Math.round((slot.minutes / maxMins) * 100))}
        <div class="timeline-bar-col" title="{slot.hour}:00 — {slot.minutes} mins">
          <div
            class="timeline-bar-fill {pct > 0 ? (slot.hour >= 9 && slot.hour <= 18 ? 'work' : 'personal') : ''}"
            style="height: {Math.max(4, pct)}%;"
          ></div>
        </div>
      {/each}
    </div>
    {#if showLabels}
      <div class="hourly-labels">
        <span>00:00</span>
        <span>06:00</span>
        <span>12:00</span>
        <span>18:00</span>
        <span>23:00</span>
      </div>
    {/if}
  </div>
{:else}
  <div class="ratio-timeline">
    <div class="ratio-track" style="height: {height};">
      {#if workPercent > 0}
        <div
          class="ratio-segment work"
          style="width: {workPercent}%;"
          title="Work: {workPercent}%"
        ></div>
      {/if}
      {#if personalPercent > 0}
        <div
          class="ratio-segment personal"
          style="width: {personalPercent}%;"
          title="Personal: {personalPercent}%"
        ></div>
      {/if}
      {#if unclassifiedPercent > 0}
        <div
          class="ratio-segment unclassified"
          style="width: {unclassifiedPercent}%;"
          title="Unclassified: {unclassifiedPercent}%"
        ></div>
      {/if}
    </div>
    {#if showLabels}
      <div class="ratio-legend">
        <span class="legend-item">
          <span class="dot work"></span> Work <strong>{workPercent}%</strong>
        </span>
        <span class="legend-item">
          <span class="dot personal"></span> Personal <strong>{personalPercent}%</strong>
        </span>
        {#if unclassifiedPercent > 0}
          <span class="legend-item">
            <span class="dot unclassified"></span> Unclassified <strong>{unclassifiedPercent}%</strong>
          </span>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .hourly-timeline { width: 100%; display: flex; flex-direction: column; gap: 4px; }
  .hourly-labels {
    display: flex; justify-content: space-between;
    font-size: 10px; color: var(--faint); font-family: ui-monospace, SFMono-Regular, monospace;
    padding-top: 2px;
  }
  .ratio-timeline { width: 100%; display: flex; flex-direction: column; gap: 8px; }
  .ratio-track {
    width: 100%; display: flex; overflow: hidden;
    border-radius: 999px; background: #161614;
    border: 1px solid var(--border);
  }
  .ratio-segment { height: 100%; transition: width 300ms ease; }
  .ratio-segment.work { background: var(--work); }
  .ratio-segment.personal { background: var(--personal); }
  .ratio-segment.unclassified { background: var(--border-strong); }
  .ratio-legend {
    display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
    font-size: 11px; color: var(--muted);
  }
  .legend-item { display: inline-flex; align-items: center; gap: 5px; }
  .legend-item strong { color: var(--text); font-weight: 600; }
  .dot { width: 7px; height: 7px; border-radius: 50%; }
  .dot.work { background: var(--work); }
  .dot.personal { background: var(--personal); }
  .dot.unclassified { background: var(--border-strong); }
</style>
