// Single application tooltip (follows the mouse). Usage: const tip = useTooltip(); tip.show(e, content); tip.hide().
import { createContext, useContext, useState, useCallback } from 'react';

const Ctx = createContext({ show() {}, hide() {} });

export function TooltipProvider({ children }) {
  const [tip, setTip] = useState(null);
  const show = useCallback((e, content) => {
    const x = Math.min(e.clientX + 14, window.innerWidth - 340);
    const y = e.clientY + 16;
    setTip({ x, y, content });
  }, []);
  const hide = useCallback(() => setTip(null), []);
  return (
    <Ctx.Provider value={{ show, hide }}>
      {children}
      {tip && (
        <div className="tooltip" role="tooltip" style={{ left: tip.x, top: tip.y }}>
          {tip.content}
        </div>
      )}
    </Ctx.Provider>
  );
}

export const useTooltip = () => useContext(Ctx);
