/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useEffect, useState } from 'react';
import { Play, RotateCcw, ZoomIn, ZoomOut, Edit, Trash2, Maximize2, Minimize2 } from 'lucide-react';
import { Candle, MarketTick, Trendline } from '../types';

interface TradingChartProps {
  symbol: string;
  candles: Candle[];
  ticks?: MarketTick[];
  oiData?: { strike: number; call_oi: number; put_oi: number; call_oi_change: number; put_oi_change: number }[];
  supportResistance?: { support: { strike: number; oi: number }[]; resistance: { strike: number; oi: number }[] };
  markers?: { time: number; position: 'aboveBar' | 'belowBar'; color: string; shape: string; text: string }[];
  timeframe: string;
  setTimeframe: (tf: string) => void;
  height?: number;
}

export default function TradingChart({
  symbol,
  candles,
  ticks = [],
  oiData = [],
  supportResistance,
  markers = [],
  timeframe,
  setTimeframe,
  height = 420,
}: TradingChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Chart settings & Viewports
  const [zoomFactor, setZoomFactor] = useState<number>(35); // Number of bars visible
  const [offsetBar, setOffsetBar] = useState<number>(0); // Panning offset in bars
  const [isDrawMode, setIsDrawMode] = useState<boolean>(false);
  const [trendlines, setTrendlines] = useState<Trendline[]>([]);
  const [viewVolatility, setViewVolatility] = useState<boolean>(true);
  const [hoverData, setHoverData] = useState<{ price: number; time: string; index: number } | null>(null);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  // Dragging and Panning States
  const isDragging = useRef<boolean>(false);
  const lastMouseX = useRef<number>(0);
  const lastMouseY = useRef<number>(0);
  const dragStartCoords = useRef<{ x: number; y: number } | null>(null);
  const [canvasWidth, setCanvasWidth] = useState<number>(600);
  const [currentHeight, setCurrentHeight] = useState<number>(height);
  const [bookmarksTrigger, setBookmarksTrigger] = useState<number>(0);

  // Adjust height dynamically when isFullscreen is toggled
  useEffect(() => {
    if (isFullscreen) {
      setCurrentHeight(window.innerHeight - 100);
    } else {
      setCurrentHeight(height);
    }
  }, [isFullscreen, height]);

  // Adjust on browser window resize
  useEffect(() => {
    const handleResize = () => {
      if (isFullscreen) {
        setCurrentHeight(window.innerHeight - 100);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isFullscreen]);

  const paddingLeft = 8;
  const paddingRight = 52; // Extra compact right Y-axis for price scaling
  const paddingTop = 12;
  const paddingBottom = 20; // Room for tight hour:minute tags below

  // Track size of container
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (let entry of entries) {
        setCanvasWidth(entry.contentRect.width || 600);
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Compute scale conversions
  const getExtents = (visibleCandles: Candle[]) => {
    if (visibleCandles.length === 0) return { minP: 22000, maxP: 22100 };
    let high = Math.max(...visibleCandles.map((c) => c.high));
    let low = Math.min(...visibleCandles.map((c) => c.low));
    
    // Tight 4% top/bottom cushion like TradingView
    const diff = high - low;
    const buffer = diff > 0 ? diff * 0.04 : 2;
    return { minP: low - buffer, maxP: high + buffer };
  };

  // Convert canvas pixel back to price and index
  const getCoordinatesFromPixel = (
    clientX: number,
    clientY: number,
    canvas: HTMLCanvasElement,
    visibleCount: number,
    startIndex: number,
    minP: number,
    maxP: number
  ) => {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    const chartWidth = canvas.width - paddingLeft - paddingRight;
    const chartHeight = canvas.height - paddingTop - paddingBottom;

    // Convert pixel X to candle index
    const colWidth = chartWidth / visibleCount;
    const relativeX = x - paddingLeft;
    const candleOffset = Math.floor(relativeX / colWidth);
    const candleIndex = startIndex + candleOffset;

    // Convert pixel Y to price
    const relativeY = y - paddingTop;
    const priceRange = maxP - minP;
    const price = maxP - (relativeY / chartHeight) * priceRange;

    return { price, index: candleIndex, x, y };
  };

  // Render Loop
  useEffect(() => {
    if (!canvasRef.current || candles.length === 0) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear background
    ctx.fillStyle = '#0b0f19'; // Rich dark interface
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const chartWidth = canvas.width - paddingLeft - paddingRight;
    const chartHeight = canvas.height - paddingTop - paddingBottom;

    // Decide visible candles based on zoom and offset
    const endIdx = Math.max(0, candles.length - offsetBar);
    const startIdx = Math.max(0, endIdx - zoomFactor);
    const visibleCandles = candles.slice(startIdx, endIdx);
    const visibleCount = visibleCandles.length;

    const { minP, maxP } = getExtents(visibleCandles);
    const priceRange = maxP - minP;

    // Helper functions for scaling coordinates
    const scaleX = (idx: number) => {
      const barRelativeIdx = idx - startIdx;
      return paddingLeft + (barRelativeIdx + 0.5) * (chartWidth / visibleCount);
    };

    const scaleY = (price: number) => {
      const fraction = (price - minP) / priceRange;
      return canvas.height - paddingBottom - fraction * chartHeight;
    };

    // 1. Draw grid lines (Horizontal price grid & Vertical time grid)
    ctx.strokeStyle = '#141d2f';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#64748b';
    ctx.font = '8.5px JetBrains Mono, monospace';
    ctx.textAlign = 'left';

    const numberOfGridLines = 6;
    for (let i = 0; i < numberOfGridLines; i++) {
       const price = minP + (priceRange * i) / (numberOfGridLines - 1);
       const y = scaleY(price);
       ctx.beginPath();
       ctx.moveTo(paddingLeft, y);
       ctx.lineTo(canvas.width - paddingRight, y);
       ctx.stroke();

       // Price Label
       ctx.fillText(price.toFixed(2), canvas.width - paddingRight + 4, y + 3);
    }

    // Draw vertical timeline gridlines & labels (TradingView style)
    if (visibleCount > 0) {
      ctx.textAlign = 'center';
      const labelInterval = Math.max(1, Math.floor(visibleCount / 5));
      for (let i = 0; i < visibleCount; i++) {
        if (i % labelInterval === 0 || i === visibleCount - 1) {
          const actualIdx = startIdx + i;
          const x = scaleX(actualIdx);
          const candle = visibleCandles[i];
          if (candle && x >= paddingLeft && x <= canvas.width - paddingRight) {
            ctx.strokeStyle = '#111827'; // Darker grid support for time columns
            ctx.beginPath();
            ctx.moveTo(x, paddingTop);
            ctx.lineTo(x, canvas.height - paddingBottom);
            ctx.stroke();

            // Time text at the base scale
            const date = new Date(candle.time * 1000);
            const timeLabel = date.toLocaleTimeString([], {
               hour: '2-digit',
               minute: '2-digit',
               hour12: false,
            });
            ctx.fillText(timeLabel, x, canvas.height - paddingBottom + 12);
          }
        }
      }
    }

    // 2. Draw Horizontal Option Interest (OI) Overlay at Strike prices
    if (oiData && oiData.length > 0) {
      const maxCallOi = Math.max(...oiData.map((d) => d.call_oi)) || 1;
      const maxPutOi = Math.max(...oiData.map((d) => d.put_oi)) || 1;
      const oiScaleWidth = 60; // max length of OI bars

      oiData.forEach((oiItem) => {
        if (oiItem.strike >= minP && oiItem.strike <= maxP) {
          const y = scaleY(oiItem.strike);

          // Call OI (Resistance - Orange-Red bars extending right-of-chart)
          const callWidth = (oiItem.call_oi / maxCallOi) * oiScaleWidth;
          ctx.fillStyle = 'rgba(239, 68, 68, 0.15)'; // Red opacity
          ctx.fillRect(canvas.width - paddingRight - callWidth, y - 6, callWidth, 5);
          ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
          ctx.lineWidth = 0.5;
          ctx.strokeRect(canvas.width - paddingRight - callWidth, y - 6, callWidth, 5);

          // Put OI (Support - Emerald Green bars extending right-of-chart)
          const putWidth = (oiItem.put_oi / maxPutOi) * oiScaleWidth;
          ctx.fillStyle = 'rgba(16, 185, 129, 0.15)'; // Green opacity
          ctx.fillRect(canvas.width - paddingRight - putWidth, y + 1, putWidth, 5);
          ctx.strokeStyle = 'rgba(16, 185, 129, 0.4)';
          ctx.lineWidth = 0.5;
          ctx.strokeRect(canvas.width - paddingRight - putWidth, y + 1, putWidth, 5);

          // Label strikes with small gray values
          ctx.fillStyle = '#475569';
          ctx.font = '9px JetBrains Mono, monospace';
          ctx.fillText(`Strike ${oiItem.strike}`, canvas.width - paddingRight + 4, y - 4);
        }
      });
    }

    // 3. Render Support and Resistance derived lines
    if (supportResistance) {
      // Resistance Lines (Red dashed)
      supportResistance.resistance.forEach((res, index) => {
        if (res.strike >= minP && res.strike <= maxP) {
          const y = scaleY(res.strike);
          ctx.strokeStyle = 'rgba(244, 63, 94, 0.65)';
          ctx.setLineDash([4, 4]);
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(paddingLeft, y);
          ctx.lineTo(canvas.width - paddingRight, y);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = '#f43f5e';
          ctx.font = '9px JetBrains Mono, monospace';
          ctx.fillText(`R${index + 1}: ${res.strike}`, paddingLeft + 10, y - 6);
        }
      });

      // Support Lines (Green dashed)
      supportResistance.support.forEach((sup, index) => {
        if (sup.strike >= minP && sup.strike <= maxP) {
          const y = scaleY(sup.strike);
          ctx.strokeStyle = 'rgba(16, 185, 129, 0.65)';
          ctx.setLineDash([4, 4]);
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(paddingLeft, y);
          ctx.lineTo(canvas.width - paddingRight, y);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = '#10b981';
          ctx.font = '9px JetBrains Mono, monospace';
          ctx.fillText(`S${index + 1}: ${sup.strike}`, paddingLeft + 10, y + 12);
        }
      });
    }

    // 4. Draw Volatility Overlay (Analytical Bollinger-like bands)
    if (viewVolatility && visibleCount > 0) {
      // Shaded standard deviation tunnel
      ctx.fillStyle = 'rgba(56, 189, 248, 0.04)'; // Light blue tint
      ctx.beginPath();

      // Upper band line
      visibleCandles.forEach((c, idx) => {
        const x = scaleX(startIdx + idx);
        // Calculate dynamic volatility based on range of active candle
        const volatilityDev = (c.high - c.low) * 1.5 || 10;
        const emaProxy = c.open * 0.4 + c.close * 0.6;
        const bandVal = emaProxy + volatilityDev;
        if (idx === 0) ctx.moveTo(x, scaleY(bandVal));
        else ctx.lineTo(x, scaleY(bandVal));
      });

      // Lower band line reversing back
      for (let i = visibleCount - 1; i >= 0; i--) {
        const c = visibleCandles[i];
        const x = scaleX(startIdx + i);
        const volatilityDev = (c.high - c.low) * 1.5 || 10;
        const emaProxy = c.open * 0.4 + c.close * 0.6;
        const bandVal = emaProxy - volatilityDev;
        ctx.lineTo(x, scaleY(bandVal));
      }
      ctx.closePath();
      ctx.fill();

      // Outer boundaries
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.15)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      visibleCandles.forEach((c, idx) => {
        const x = scaleX(startIdx + idx);
        const volatilityDev = (c.high - c.low) * 1.5 || 10;
        const bandVal = (c.open * 0.4 + c.close * 0.6) + volatilityDev;
        if (idx === 0) ctx.moveTo(x, scaleY(bandVal));
        else ctx.lineTo(x, scaleY(bandVal));
      });
      ctx.stroke();

      ctx.beginPath();
      visibleCandles.forEach((c, idx) => {
        const x = scaleX(startIdx + idx);
        const volatilityDev = (c.high - c.low) * 1.5 || 10;
        const bandVal = (c.open * 0.4 + c.close * 0.6) - volatilityDev;
        if (idx === 0) ctx.moveTo(x, scaleY(bandVal));
        else ctx.lineTo(x, scaleY(bandVal));
      });
      ctx.stroke();
    }

    // 5. Draw EMA Indicators
    // EMA 9 (Blue)
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let ema9Active = false;
    visibleCandles.forEach((c, idx) => {
      const actualIdx = startIdx + idx;
      // We check if value is available or compute a simple EMA running values
      let emaValue = c.close;
      if (idx > 0) {
        const prevCandle = visibleCandles[idx - 1];
        emaValue = c.close * 0.2 + prevCandle.close * 0.8;
      }
      const x = scaleX(actualIdx);
      const y = scaleY(emaValue);
      if (!ema9Active) {
        ctx.moveTo(x, y);
        ema9Active = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();

    // EMA 20 (Orange)
    ctx.strokeStyle = '#f97316';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let ema20Active = false;
    visibleCandles.forEach((c, idx) => {
      const actualIdx = startIdx + idx;
      let emaValue = c.close;
      if (idx > 4) {
        let sum = 0;
        for (let j = 0; j < 5; j++) sum += visibleCandles[idx - j].close;
        emaValue = sum / 5; // Simple SMA as reliable overlay proxy
      }
      const x = scaleX(actualIdx);
      const y = scaleY(emaValue);
      if (!ema20Active) {
        ctx.moveTo(x, y);
        ema20Active = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();

    // 6. Draw Candlesticks
    const barWidth = Math.max(3, (chartWidth / visibleCount) * 0.7);

    // Calculate 200-period simple moving average of volume
    let avgVolume = 1;
    if (candles.length > 0) {
      const volSum = candles.slice(-200).reduce((sum, c) => sum + (c.volume || 0), 0);
      avgVolume = (volSum / Math.min(200, candles.length)) || 1;
    }

    visibleCandles.forEach((candle, idx) => {
      const actualIdx = startIdx + idx;
      const x = scaleX(actualIdx);
      const yOpen = scaleY(candle.open);
      const yClose = scaleY(candle.close);
      const yHigh = scaleY(candle.high);
      const yLow = scaleY(candle.low);

      const isBullish = candle.close >= candle.open;
      const rvol = (candle.volume || 1) / avgVolume;

      // Continuous scale:
      // RVOL = 1 => 50% transparency (0.5 opacity)
      // RVOL = 2 => 0% transparency (1.0 opacity)
      // Cap RVOL impact at 2.0 and min at 0.1
      const rvolClamped = Math.max(0.1, Math.min(2.0, rvol));
      
      let opacity = 0.5;
      if (rvolClamped <= 1.0) {
        opacity = 0.1 + (rvolClamped - 0.1) * (0.4 / 0.9);
      } else {
        opacity = 0.5 + (rvolClamped - 1.0) * 0.5;
      }

      // Color continuous shading:
      // If RVOL <= 1: normal visual colors
      // If RVOL > 1: morph continuously to rich deeper colors (dark teal / dark maroon/wine)
      const factor = Math.max(0, Math.min(1, rvolClamped - 1.0)); // 0 at RVOL 1, 1 at RVOL 2
      
      let r, g, b;
      let strokeColor, wickColor;
      if (isBullish) {
        // Interpolate bright green (16, 185, 129) to dark teal (4, 120, 120)
        r = Math.round(16 + (4 - 16) * factor);
        g = Math.round(185 + (120 - 185) * factor);
        b = Math.round(129 + (115 - 129) * factor);
        
        wickColor = `rgba(${r}, ${g}, ${b}, ${Math.min(1.0, opacity + 0.3)})`;
        strokeColor = `rgba(${r}, ${g}, ${b}, ${Math.min(1.0, opacity + 0.15)})`;
      } else {
        // Interpolate bright rose (244, 63, 94) to dark maroon (120, 10, 10)
        r = Math.round(244 + (120 - 244) * factor);
        g = Math.round(63 + (10 - 63) * factor);
        b = Math.round(94 + (10 - 94) * factor);
        
        wickColor = `rgba(${r}, ${g}, ${b}, ${Math.min(1.0, opacity + 0.3)})`;
        strokeColor = `rgba(${r}, ${g}, ${b}, ${Math.min(1.0, opacity + 0.15)})`;
      }

      const bodyColor = `rgba(${r}, ${g}, ${b}, ${opacity})`;

      // Draw wick
      ctx.strokeStyle = wickColor;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x, yHigh);
      ctx.lineTo(x, yLow);
      ctx.stroke();

      // Draw body
      ctx.fillStyle = bodyColor;
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 1.3;

      const bodyTop = Math.min(yOpen, yClose);
      const bodyHeight = Math.max(1.5, Math.abs(yOpen - yClose));

      ctx.fillRect(x - barWidth / 2, bodyTop, barWidth, bodyHeight);
      ctx.strokeRect(x - barWidth / 2, bodyTop, barWidth, bodyHeight);

      // Draw volumetric trade dot overlays under/in this candle
      // Check if ticks are inside this candle timeframe
      const candleStartSec = candle.time;
      const timeframeSec = timeframe.endsWith('m') ? parseInt(timeframe) * 60 : 60;
      const tickMatches = ticks.filter(
        (t) =>
          t.ts_ms / 1000 >= candleStartSec &&
          t.ts_ms / 1000 < candleStartSec + timeframeSec
      );

      // Render high speed dots
      if (tickMatches.length > 0) {
        tickMatches.forEach((tick) => {
          const tickY = scaleY(tick.price);
          const size = Math.min(6, 2.5 + (tick.volume ? Math.sqrt(tick.volume) / 100 : 1.5));
          ctx.beginPath();
          ctx.arc(x, tickY, size, 0, 2 * Math.PI);
          ctx.fillStyle = isBullish ? `rgba(${r}, ${g}, ${b}, 0.7)` : `rgba(${r}, ${g}, ${b}, 0.7)`;
          ctx.fill();
        });
      }
    });

    // 7. Render Markers (Psychology signals / Absorption / Vacuums)
    markers.forEach((marker) => {
      // Find candle match by time
      const index = candles.findIndex(
        (c) => Math.abs(c.time - marker.time) < 60
      );
      if (index >= startIdx && index < endIdx) {
        const x = scaleX(index);
        const candle = candles[index];

        if (marker.position === 'belowBar') {
          const y = scaleY(candle.low) + 12;

          // Green Arrow Up
          ctx.fillStyle = '#10b981';
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x - 5, y + 8);
          ctx.lineTo(x + 5, y + 8);
          ctx.closePath();
          ctx.fill();

          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 9px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(marker.text, x, y + 18);
        } else {
          const y = scaleY(candle.high) - 12;

          // Red Arrow Down
          ctx.fillStyle = '#ef4444';
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x - 5, y - 8);
          ctx.lineTo(x + 5, y - 8);
          ctx.closePath();
          ctx.fill();

          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 9px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(marker.text, x, y - 14);
        }
      }
    });

    // 8. Draw Custom Trendlines
    ctx.lineWidth = 1.8;
    ctx.setLineDash([]);
    trendlines.forEach((line) => {
      const startXVal = scaleX(line.startX);
      const startYVal = scaleY(line.startY);
      const endXVal = scaleX(line.endX);
      const endYVal = scaleY(line.endY);

      ctx.strokeStyle = line.color;
      ctx.beginPath();
      ctx.moveTo(startXVal, startYVal);
      ctx.lineTo(endXVal, endYVal);
      ctx.stroke();

      // Draw endpoints markers
      ctx.fillStyle = '#38bdf8';
      ctx.beginPath();
      ctx.arc(startXVal, startYVal, 3.5, 0, 2 * Math.PI);
      ctx.arc(endXVal, endYVal, 3.5, 0, 2 * Math.PI);
      ctx.fill();
    });

    // 9. Draw current drawing trendline (temp drag state)
    if (isDrawMode && dragStartCoords.current && isDragging.current) {
      const currentX = lastMouseX.current;
      const currentY = lastMouseY.current;

      ctx.strokeStyle = '#f43f5e';
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(dragStartCoords.current.x, dragStartCoords.current.y);
      ctx.lineTo(currentX, currentY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 10. Draw Hover crosshair
    if (hoverData) {
      const hoverX = scaleX(hoverData.index);
      const hoverY = scaleY(hoverData.price);

      if (hoverX >= paddingLeft && hoverX <= canvas.width - paddingRight) {
        // Vertical dashed line
        ctx.strokeStyle = '#1e293b';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(hoverX, paddingTop);
        ctx.lineTo(hoverX, canvas.height - paddingBottom);
        ctx.stroke();

        // Horizontal dashed line
        ctx.beginPath();
        ctx.moveTo(paddingLeft, hoverY);
        ctx.lineTo(canvas.width - paddingRight, hoverY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Price indicator pill at right axis
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(canvas.width - paddingRight, hoverY - 9, paddingRight, 18);
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1;
        ctx.strokeRect(canvas.width - paddingRight, hoverY - 9, paddingRight, 18);

        ctx.fillStyle = '#38bdf8';
        ctx.font = '8.5px JetBrains Mono, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(hoverData.price.toFixed(2), canvas.width - paddingRight + 3, hoverY + 3);

        // Time indicator pill at bottom axis (TradingView Style)
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(hoverX - 25, canvas.height - paddingBottom, 50, 15);
        ctx.strokeStyle = '#38bdf8';
        ctx.strokeRect(hoverX - 25, canvas.height - paddingBottom, 50, 15);

        ctx.fillStyle = '#38bdf8';
        ctx.font = '8.5px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(hoverData.time.split(':').slice(0, 2).join(':'), hoverX, canvas.height - paddingBottom + 10);
      }
    }

    // Canvas Frame Border
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.strokeRect(
      paddingLeft,
      paddingTop,
      canvas.width - paddingLeft - paddingRight,
      canvas.height - paddingTop - paddingBottom
    );
  }, [candles, zoomFactor, offsetBar, trendlines, isDrawMode, hoverData, oiData, supportResistance, bookmarksTrigger, viewVolatility, canvasWidth, currentHeight, markers, ticks]);

  // Mouse Handlers
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current || candles.length === 0) return;
    const canvas = canvasRef.current;

    const endIdx = Math.max(0, candles.length - offsetBar);
    const startIdx = Math.max(0, endIdx - zoomFactor);
    const visibleCandles = candles.slice(startIdx, endIdx);
    const { minP, maxP } = getExtents(visibleCandles);

    const pos = getCoordinatesFromPixel(
      e.clientX,
      e.clientY,
      canvas,
      visibleCandles.length,
      startIdx,
      minP,
      maxP
    );

    isDragging.current = true;
    lastMouseX.current = pos.x;
    lastMouseY.current = pos.y;

    if (isDrawMode) {
      dragStartCoords.current = { x: pos.x, y: pos.y };
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current || candles.length === 0) return;
    const canvas = canvasRef.current;

    const endIdx = Math.max(0, candles.length - offsetBar);
    const startIdx = Math.max(0, endIdx - zoomFactor);
    const visibleCandles = candles.slice(startIdx, endIdx);
    const { minP, maxP } = getExtents(visibleCandles);

    const pos = getCoordinatesFromPixel(
      e.clientX,
      e.clientY,
      canvas,
      visibleCandles.length,
      startIdx,
      minP,
      maxP
    );

    // Update coordinates for dynamic indicators
    lastMouseX.current = pos.x;
    lastMouseY.current = pos.y;

    // Crosshair hover coordinates mapping
    if (pos.x >= paddingLeft && pos.x <= canvas.width - paddingRight) {
      // Find actual matching index
      const fractionalPos = (pos.x - paddingLeft) / (canvas.width - paddingLeft - paddingRight);
      const candleOffset = Math.floor(fractionalPos * visibleCandles.length);
      const matchedIdx = Math.min(candles.length - 1, Math.max(0, startIdx + candleOffset));
      const candle = candles[matchedIdx];

      if (candle) {
        const timeStr = new Date(candle.time * 1000).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
        setHoverData({ price: pos.price, time: timeStr, index: matchedIdx });
      }
    } else {
      setHoverData(null);
    }

    if (!isDragging.current) return;

    if (isDrawMode && dragStartCoords.current) {
      // Repaint temp drag line
      setBookmarksTrigger((prev) => prev + 1);
    } else {
      // DRAGGING TO PAN CHART
      const dx = pos.x - lastMouseX.current;
      const chartWidth = canvas.width - paddingLeft - paddingRight;
      const barsMoved = Math.round((dx / chartWidth) * zoomFactor);

      if (barsMoved !== 0) {
        setOffsetBar((prev) => Math.max(0, prev + barsMoved));
        lastMouseX.current = pos.x;
      }
    }
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDragging.current) return;
    isDragging.current = false;

    if (isDrawMode && dragStartCoords.current) {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const endIdx = Math.max(0, candles.length - offsetBar);
      const startIdx = Math.max(0, endIdx - zoomFactor);
      const visibleCandles = candles.slice(startIdx, endIdx);
      const { minP, maxP } = getExtents(visibleCandles);

      // Start coordinate translation
      const startPos = getCoordinatesFromPixel(
        dragStartCoords.current.x + canvas.getBoundingClientRect().left,
        dragStartCoords.current.y + canvas.getBoundingClientRect().top,
        canvas,
        visibleCandles.length,
        startIdx,
        minP,
        maxP
      );

      // End coordinate translation
      const endPos = getCoordinatesFromPixel(
        e.clientX,
        e.clientY,
        canvas,
        visibleCandles.length,
        startIdx,
        minP,
        maxP
      );

      const newLine: Trendline = {
        id: `trend-${Date.now()}`,
        startX: startPos.index,
        startY: startPos.price,
        endX: endPos.index,
        endY: endPos.price,
        color: '#f43f5e', // Hot rose
        lineWidth: 2,
      };

      setTrendlines((prev) => [...prev, newLine]);
      dragStartCoords.current = null;
      setIsDrawMode(false); // Draw complete
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    // Zoom charts based on roll
    e.preventDefault();
    if (e.deltaY < 0) {
      // Zoom In (Less bars visible)
      setZoomFactor((prev) => Math.max(10, prev - 3));
    } else {
      // Zoom Out (More bars visible)
      setZoomFactor((prev) => Math.min(150, prev + 3));
    }
  };

  const clearLines = () => {
    setTrendlines([]);
  };

  return (
    <div
      ref={containerRef}
      id={`chart-wrap-${symbol.replace(':', '-')}`}
      className={`group/chart flex flex-col bg-[#070b14] border border-[#1e293b] rounded-lg shadow-2xl transition-all duration-200 ${
        isFullscreen
          ? 'fixed inset-4 z-[100] m-0 w-[calc(100vw-32px)] h-[calc(100vh-32px)] bg-[#040810] p-4 flex flex-col'
          : 'relative overflow-hidden'
      }`}
    >
      {/* Header toolbar */}
      <div className="flex items-center justify-between pl-[7px] pr-[3px] pt-0 pb-0 h-[26px] rounded-t-[4px] bg-[#0d1527] border-b border-[#1e293b] gap-1 overflow-hidden">
        <div className="flex items-center space-x-1.5 min-w-0">
          <span className="text-[10px] font-bold font-mono px-1.5 py-0 rounded bg-blue-500/15 text-blue-400 border border-blue-500/35">
            {symbol}
          </span>
          <span className="text-[10px] text-slate-400 font-mono hidden sm:inline truncate">
            {candles.length > 0 ? `LTP: ₹${candles[candles.length - 1].close.toFixed(2)}` : ''}
          </span>
          {isFullscreen && (
            <span className="text-[9px] text-emerald-400 bg-emerald-500/10 px-1 py-0 rounded animate-pulse font-bold uppercase font-mono">
              MTF Spot Popout
            </span>
          )}
        </div>

        {/* Hover-revealed tools */}
        <div className="flex items-center space-x-2 transition-opacity duration-200 opacity-0 group-hover/chart:opacity-100 pointer-events-none group-hover/chart:pointer-events-auto shrink-0">
          {/* Timeframe Buttons */}
          <div className="flex items-center gap-0.5">
            {['1m', '3m', '5m', '15m', '1h'].map((tf) => (
              <button
                key={tf}
                onClick={() => setTimeframe(tf)}
                className={`px-1 py-0 rounded text-[9.5px] font-medium transition-colors ${
                  timeframe === tf
                    ? 'bg-blue-600 text-white font-bold shadow-md'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800'
                }`}
              >
                {tf}
              </button>
            ))}
          </div>

          {/* Dynamic Controls */}
          <div className="flex items-center space-x-1">
            <button
              onClick={() => setViewVolatility(!viewVolatility)}
              className={`p-0.5 rounded text-[10px] transition-colors flex items-center gap-0.5 ${
                viewVolatility ? 'bg-sky-500/15 text-sky-400' : 'text-slate-400 hover:bg-slate-800'
              }`}
              title="Volatility Overlays"
            >
              <Play className="w-3 h-3 rotate-90" />
              <span className="text-[9px] uppercase hidden md:inline">VOL BANDS</span>
            </button>

            <button
              onClick={() => setIsDrawMode(!isDrawMode)}
              className={`p-0.5 rounded text-[10px] transition-colors flex items-center gap-0.5 ${
                isDrawMode ? 'bg-[#f43f5e]/15 text-[#f43f5e]' : 'text-slate-400 hover:bg-slate-800'
              }`}
              title="Interactive Quick-Draw Line"
            >
              <Edit className="w-3 h-3" />
              <span className="text-[9px] uppercase hidden md:inline">Draw Line</span>
            </button>

            {trendlines.length > 0 && (
              <button
                onClick={clearLines}
                className="p-0.5 rounded text-[10px] text-rose-400 hover:bg-slate-800"
                title="Clear custom lines"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            )}

            <div className="h-3 w-px bg-slate-800" />

            {/* Manual Zoom buttons */}
            <button
              onClick={() => setZoomFactor((prev) => Math.max(12, prev - 8))}
              className="p-0.5 rounded hover:bg-slate-800 text-slate-400 hover:text-white"
              title="Zoom In"
            >
              <ZoomIn className="w-3 h-3" />
            </button>
            <button
              onClick={() => setZoomFactor((prev) => Math.min(120, prev + 8))}
              className="p-0.5 rounded hover:bg-slate-800 text-slate-400 hover:text-white"
              title="Zoom Out"
            >
              <ZoomOut className="w-3 h-3" />
            </button>
            <button
              onClick={() => {
                setOffsetBar(0);
                setZoomFactor(35);
              }}
              className="p-0.5 rounded hover:bg-slate-800 text-slate-400 hover:text-white"
              title="Reset Panning Index"
            >
              <RotateCcw className="w-3 h-3" />
            </button>

            <div className="h-3 w-px bg-slate-800" />

            {/* Pop-out fullscreen button */}
            <button
              onClick={() => setIsFullscreen(!isFullscreen)}
              className="p-0.5 rounded hover:bg-slate-800 text-slate-400 hover:text-white flex items-center gap-0.5 transition-all"
              title={isFullscreen ? "Exit Fullscreen" : "Fullscreen Chart Popout"}
            >
              {isFullscreen ? <Minimize2 className="w-3.5 h-3.5 text-sky-400" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      </div>

      {/* Main viewport block */}
      <div className="relative flex-grow" style={{ height: `${currentHeight}px` }}>
        <canvas
          ref={canvasRef}
          width={canvasWidth}
          height={currentHeight}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onWheel={handleWheel}
          className="block w-full h-full cursor-crosshair border-b border-[#111827]"
        />

        {/* Hover info overlay floating HUD */}
        {hoverData && (
          <div className="absolute top-2 left-4 px-2 py-1 bg-[#111827]/90 text-[10px] text-slate-300 rounded border border-[#1e293b] font-mono pointer-events-none z-20 flex space-x-3 shadow-lg">
            <span>
              TIME: <span className="text-white">{hoverData.time}</span>
            </span>
            <span>
              SEL: <span className="text-sky-400">₹{hoverData.price.toFixed(2)}</span>
            </span>
            {candles[hoverData.index] && (
              <>
                <span>
                  O: <span className="text-emerald-400">{candles[hoverData.index].open.toFixed(1)}</span>
                </span>
                <span>
                  H: <span className="text-emerald-400">{candles[hoverData.index].high.toFixed(1)}</span>
                </span>
                <span>
                  L: <span className="text-rose-400">{candles[hoverData.index].low.toFixed(1)}</span>
                </span>
                <span>
                  C: <span className="text-emerald-400">{candles[hoverData.index].close.toFixed(1)}</span>
                </span>
                <span>
                  VOL:{' '}
                  <span className="text-yellow-400">
                    {candles[hoverData.index].volume.toLocaleString()}
                  </span>
                </span>
              </>
            )}
          </div>
        )}

        {/* Draw Line Active HUD alert */}
        {isDrawMode && (
          <div className="absolute top-2 right-4 px-2 py-1 bg-rose-500/10 text-[10px] text-rose-400 rounded border border-rose-500/20 font-bold pointer-events-none animate-pulse z-20 shadow-lg">
            DRAG & DRAW ON CHART ACTIVE
          </div>
        )}
      </div>
    </div>
  );
}
