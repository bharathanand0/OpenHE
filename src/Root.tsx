import { useEffect } from 'react';
import App from './App';
import { DriverApp } from './driverApp/DriverApp';
import { driverConnection, useDriverConnection } from './driverApp/store';

/**
 * AULA boards use the original app; libhmk and RongYuan boards, which go
 * through the driver layer, get the driver workspace while connected.
 */
export function Root() {
  const conn = useDriverConnection();
  useEffect(() => {
    void driverConnection.restore();
  }, []);
  return conn.state === 'connected' ? (
    <DriverApp key={conn.driver.info.name} driver={conn.driver} />
  ) : (
    <App />
  );
}
