'use client';
import { useEffect, useRef } from 'react';
import { useReducedMotion } from '@mantine/hooks';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, ScatterChart, HeatmapChart } from 'echarts/charts';
import {
  AriaComponent,
  BrushComponent,
  DataZoomComponent,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
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
  DataZoomComponent,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
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
    callbacks.current.onReady?.(chart);
    return () => {
      observer.disconnect();
      chart.dispose();
      instance.current = null;
    };
  }, []);
  useEffect(() => {
    instance.current?.setOption(
      {
        textStyle: { fontFamily: 'IBM Plex Sans', fontSize: 13 },
        aria: { enabled: true, label: { description: label } },
        animation: !reduceMotion,
        animationDuration: 220,
        animationDurationUpdate: 180,
        ...option,
      },
      { notMerge: true }
    );
  }, [option, reduceMotion, label]);
  return (
    <div ref={element} className={styles.chart} style={{ height }} role="img" aria-label={label} />
  );
}
