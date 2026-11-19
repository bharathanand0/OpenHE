import { useEffect } from 'react';
import App from './App';
import { useAppMode } from './appMode';
import { DriverApp } from './driverApp/DriverApp';
import { Landing } from './driverApp/Landing';
import { driverConnection, useDriverConnection } from './driverApp/store';

/**
 * A connected libhmk or RongYuan board gets the driver workspace. Otherwise
 * the OpenHE start screen, or the original AULA app for those who chose it.
 */
export function Root() {
  const conn = useDriverConnection();
  const mode = useAppMode();
  useEffect(() => {
    void driverConnection.restore();
  }, []);
  if (conn.state === 'connected')
    return <DriverApp key={conn.driver.info.name} driver={conn.driver} />;
  return mode === 'aula' ? <App /> : <Landing />;
}
