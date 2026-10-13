import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

const P: Record<string, string[]> = {
  x: ['M18 6 6 18', 'm6 6 12 12'], plus: ['M5 12h14', 'M12 5v14'], minus: ['M5 12h14'], check: ['M20 6 9 17l-5-5'],
  moon: ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z'], chevron: ['m9 18 6-6-6-6'], activity: ['M22 12h-4l-3 9L9 3l-3 9H2'],
  users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
  building: ['M3 21h18', 'M5 21V7l8-4v18', 'M19 21V11l-6-4'],
  alert: ['M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z', 'M12 9v4', 'M12 17h.01'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'm16 17 5-5-5-5', 'M21 12H9'],
  refresh: ['M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16', 'M8 16H3v5'],
  sun: ['M12 2v2', 'M12 20v2', 'm4.93 4.93 1.41 1.41', 'm17.66 17.66 1.41 1.41', 'M2 12h2', 'M20 12h2', 'm6.34 17.66-1.41 1.41', 'm19.07 4.93-1.41 1.41'],
  infinity: ['M18.178 8c5.096 0 5.096 8 0 8-5.095 0-7.133-8-12.739-8-4.585 0-4.585 8 0 8 5.606 0 7.644-8 12.74-8z'],
  undo: ['M3 7v6h6', 'M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13'],
};
export type IconName = keyof typeof P | 'search' | 'lock';
export function Icon({ name, size = 18, color = '#888', stroke = 1.9 }: { name: IconName; size?: number; color?: string; stroke?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      {name === 'search' && (<><Circle cx={11} cy={11} r={8} /><Path d="m21 21-4.3-4.3" /></>)}
      {name === 'lock' && (<><Rect x={3} y={11} width={18} height={11} rx={2} /><Path d="M7 11V7a5 5 0 0 1 10 0v4" /></>)}
      {name === 'sun' && <Circle cx={12} cy={12} r={4} />}
      {name === 'users' && <Circle cx={9} cy={7} r={4} />}
      {(P[name] || []).map((d, i) => <Path key={i} d={d} />)}
    </Svg>
  );
}
