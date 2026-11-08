import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Shell } from './App';
import './styles.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ConfigProvider
        locale={zhCN}
        theme={{
          token: {
            colorPrimary: '#4F46E5',
            colorSuccess: '#22C55E',
            colorWarning: '#F59E0B',
            colorError: '#EF4444',
            colorBgLayout: '#F5F6F8',
            borderRadius: 6,
            fontFamily: "'Microsoft YaHei UI', 'Segoe UI', 'PingFang SC', sans-serif",
          },
        }}
      >
        <AntApp message={{ top: 56, maxCount: 3 }}>
          <Shell />
        </AntApp>
      </ConfigProvider>
    </StrictMode>,
  );
}
