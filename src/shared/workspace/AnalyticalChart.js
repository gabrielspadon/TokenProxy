'use client';
import { useEffect, useRef } from 'react';
import { useReducedMotion } from '@mantine/hooks';
import { useComputedColorScheme } from '@mantine/core';
import { chartThemeColors, chartMetricColors, themeChartMetrics } from './metricColors';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, ScatterChart, HeatmapChart } from 'echarts/charts';
import {
  AriaComponent,
  BrushComponent,
  CalendarComponent,
  DataZoomComponent,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  TitleComponent,
  VisualMapComponent,
  ToolboxComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import styles from './workspace.module.css';

echarts.use([
  BarChart,
  LineChart,
  ScatterChart,
  HeatmapChart,
  AriaComponent,
  BrushComponent,
  CalendarComponent,
  DataZoomComponent,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  TitleComponent,
  VisualMapComponent,
  ToolboxComponent,
  CanvasRenderer,
]);
export { METRIC_COLORS } from './metricColors';

export function AnalyticalChart({ option, height = 120, label, onEvents, onReady }) {
  const element = useRef(null),
    instance = useRef(null),
    callbacks = useRef({ onEvents, onReady });
  const reduceMotion = useReducedMotion();
  const scheme = useComputedColorScheme('light');
  useEffect(() => {
    callbacks.current = { onEvents, onReady };
  }, [onEvents, onReady]);
  useEffect(() => {
    const chart = echarts.init(element.current, null, { renderer: 'canvas' });
    instance.current = chart;
    for (const name of ['click', 'brushEnd', 'datazoom'])
      chart.on(name, (event) => callbacks.current.onEvents?.[name]?.(event, chart));
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(element.current);
    document.fonts?.ready.then(() => { if (!chart.isDisposed()) chart.resize(); });
    callbacks.current.onReady?.(chart);
    return () => {
      observer.disconnect();
      chart.dispose();
      instance.current = null;
    };
  }, []);
  useEffect(() => {
    const colors = chartThemeColors();
    const palette = chartMetricColors();
    const themed = themeChartMetrics(option, palette);
    const axes = (axes) => axes == null ? undefined : (Array.isArray(axes) ? axes : [axes]).map((axis) => ({
      ...axis,
      axisLabel: { ...axis.axisLabel, fontFamily: 'Manrope', fontSize: Math.max(13, axis.axisLabel?.fontSize || 13), color: colors.slate },
      nameTextStyle: { ...axis.nameTextStyle, color: colors.slate },
      axisLine: { ...axis.axisLine, lineStyle: { ...axis.axisLine?.lineStyle, color: colors.slate } },
      splitLine: { ...axis.splitLine, lineStyle: { ...axis.splitLine?.lineStyle, color: colors.rule } },
    }));
    instance.current?.setOption(
      {
        color: Object.values(palette),
        textStyle: { fontFamily: 'Manrope', fontSize: 13, color: colors.ink },
        aria: { enabled: true, label: { description: label } },
        animation: !reduceMotion,
        animationDuration: 220,
        animationDurationUpdate: 180,
        ...themed,
        xAxis: axes(themed.xAxis),
        yAxis: axes(themed.yAxis),
        tooltip: { backgroundColor: colors.raised, borderColor: colors.slate,
          ...themed.tooltip, textStyle: { ...themed.tooltip?.textStyle, fontFamily: 'Manrope', fontSize: 13, color: colors.ink } },
        legend: themed.legend ? { ...themed.legend, textStyle: { ...themed.legend.textStyle, color: colors.slate, fontFamily: 'Manrope', fontSize: 13 } } : undefined,
      },
      { notMerge: true }
    );
  }, [option, reduceMotion, label, scheme]);
  return (
    <div ref={element} className={styles.chart} style={{ height }} role="img" aria-label={label} />
  );
}
