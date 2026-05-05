import React, { useState, useEffect, useMemo } from "react";
import {
  Search,
  RefreshCw,
  Monitor,
  AlertCircle,
  Wifi,
  ChevronRight,
  Activity,
  Smartphone,
  Server,
  Loader2,
  Camera,
  Printer,
  Tv,
  Cpu,
  FileDown,
  Shield,
  ShieldCheck,
  Edit2,
  Clock,
  BarChart2,
  PieChart,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

// --- Helper Functions ---
const getDeviceIcon = (device, customNames = {}) => {
  const type = device.deviceType?.toLowerCase() || "";
  const name = (customNames[device.mac] || device.name || "").toLowerCase();

  if (type === "mobile" || name.includes("phone") || name.includes("android"))
    return <Smartphone size={18} />;
  if (type === "camera" || name.includes("camera") || name.includes("ipc"))
    return <Camera size={18} />;
  if (type === "router" || name.includes("router") || name.includes("tplink"))
    return <Wifi size={18} />;
  if (type === "server" || name.includes("nas")) return <Server size={18} />;
  if (type === "printer" || name.includes("print"))
    return <Printer size={18} />;
  if (type === "tv" || name.includes("smarttv")) return <Tv size={18} />;
  if (type === "iot" || type === "smart device") return <Cpu size={18} />;
  return <Monitor size={18} />;
};

const getQualityColor = (latency) => {
  if (latency === null || latency === undefined) return "#64748b";
  if (latency < 20) return "#10b981";
  if (latency < 100) return "#f59e0b";
  return "#ef4444";
};

const getDailyUsage = (mac, scanHistory) => {
  const events = scanHistory[mac] || [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayStart = today.getTime();
  const dayEnd = dayStart + 86400000;

  const todayEvents = events.filter(e => e.ts >= dayStart && e.ts < dayEnd);
  let totalTime = 0;
  let onlineStart = null;

  todayEvents.forEach(e => {
    if (e.event === 'Online') onlineStart = e.ts;
    else if (e.event === 'Offline' && onlineStart) {
      totalTime += (e.ts - onlineStart);
      onlineStart = null;
    }
  });

  if (onlineStart) {
    totalTime += (Date.now() - onlineStart);
  }
  return totalTime; // in ms
};

const formatDuration = (ms) => {
  if (!ms) return '0 phút';
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours === 0) return `${minutes} phút`;
  return `${hours} giờ ${minutes} phút`;
};

const MDNS_LABELS = {
  model: 'Dòng máy (Model)',
  deviceid: 'ID định danh thiết bị',
  srcvers: 'Phiên bản phần mềm',
  features: 'Tính năng hỗ trợ',
  flags: 'Cấu hình hệ thống (Flags)',
  pk: 'Khóa bảo mật thiết bị',
  pi: 'ID phiên bản duy nhất',
  psi: 'ID dịch vụ kết nối',
  protovers: 'Phiên bản giao thức',
  at: 'Trạng thái hoạt động',
  acl: 'Quyền truy cập (ACL)',
  gid: 'ID nhóm thiết bị',
  fex: 'Dữ liệu tính năng mở rộng',
  rsf: 'Trạng thái nguồn điện',
  ff: 'Cấu hình phần cứng',
  cv: 'Phiên bản điều khiển',
  st: 'Trạng thái hiện tại',
  fn: 'Tên hiển thị (Friendly Name)',
  md: 'Mô tả chi tiết',
  ve: 'Phiên bản phần cứng'
};

// --- Main App Component ---
const App = () => {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [reportSent, setReportSent] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [lastScanTime, setLastScanTime] = useState(null);
  const [newlyDetected, setNewlyDetected] = useState([]);
  const [selectedDevice, setSelectedDevice] = useState(null);

  // Progress State (hidden since scans are fast now)
  const [progress, setProgress] = useState({ current: 0, total: 0, percent: 0 });


  // Group 3 State
  const [autoScan, setAutoScan] = useState(false);
  const [scanInterval, setScanInterval] = useState(60000); // Default 1 min
  const [enableNotifications, setEnableNotifications] = useState(true);
  const [lostDevices, setLostDevices] = useState([]);

  const [customNames, setCustomNames] = useState({});
  const [latencyHistory, setLatencyHistory] = useState({});
  const [scanHistory, setScanHistory] = useState({});
  const [parentalControls, setParentalControls] = useState({});
  const [notifiedRestrictions, setNotifiedRestrictions] = useState({});
  const [activeTab, setActiveTab] = useState('devices'); // 'devices' | 'timeline'

  // Auto-detect subnet and load settings on mount
  useEffect(() => {
    const init = async () => {
      try {
        if (!window.electronAPI) {
          console.warn("electronAPI is not available. Running in browser mode?");
          setError("Ứng dụng đang mở trên trình duyệt web nên không có quyền truy cập hệ thống. Vui lòng xem cửa sổ phần mềm NetScan Pro (Electron) vừa được mở lên.");
          return;
        }
        // Subnet auto-detection is now handled on the backend automatically


        const savedNames = await window.electronAPI.storeGet('customNames');
        if (savedNames) setCustomNames(savedNames);



        const savedHistory = await window.electronAPI.storeGet('scanHistory');
        if (savedHistory) setScanHistory(savedHistory);

        const savedPC = await window.electronAPI.storeGet('parentalControls');
        if (savedPC) setParentalControls(savedPC);
      } catch (err) {
        console.error("Initialization error:", err);
      }
    };
    init();

    // Listen for progress
    if (window.electronAPI) {
      window.electronAPI.onScanProgress((data) => {
        setProgress(data);
      });

      // Real-time background update listener
      window.electronAPI.onNetworkUpdate((data) => {
        console.log('[App] Real-time network update received:', data.devices.length);
        setDevices(prev => {
          // Merge logic: preserve enrichment data for existing devices
          return data.devices.map(newDevice => {
            const existing = prev.find(d => d.mac === newDevice.mac);
            if (existing) {
              return { ...newDevice, ...existing, online: true };
            }
            return { ...newDevice, online: true };
          });
        });
        setLastScanTime(new Date().toLocaleTimeString());
      });

      // Real-time latency update listener
      window.electronAPI.onLatencyUpdate((updates) => {
        setDevices(prev => prev.map(d => {
          if (updates[d.ip] !== undefined) {
            return { ...d, latency: updates[d.ip] };
          }
          return d;
        }));
        setSelectedDevice(prev => {
          if (prev && updates[prev.ip] !== undefined) {
            return { ...prev, latency: updates[prev.ip] };
          }
          return prev;
        });
      });
    }
  }, []);

  const scanNetwork = async () => {
    if (loading) return;
    setLoading(true);
    setReportSent(false);
    setError(null);
    try {
      const data = await window.electronAPI.scanNetwork();


      if (data.success) {
        const currentMacs = data.devices.map(d => d.mac);
        const previousMacs = devices.map(d => d.mac);

        const newlyFound = data.devices.filter(d => !previousMacs.includes(d.mac));
        const missing = devices.filter(d => !currentMacs.includes(d.mac));

        const nowTs = Date.now();
        const timestamp = new Date().toLocaleString();
        const nowStr = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

        setScanHistory(prev => {
          const next = { ...prev };
          newlyFound.forEach(d => {
            if (!next[d.mac]) next[d.mac] = [];
            next[d.mac].push({ event: 'Online', time: timestamp, ts: nowTs });
          });
          missing.forEach(d => {
            if (!next[d.mac]) next[d.mac] = [];
            next[d.mac].push({ event: 'Offline', time: timestamp, ts: nowTs });
          });
          // Limit history
          Object.keys(next).forEach(mac => {
            if (next[mac].length > 100) next[mac].shift();
          });
          window.electronAPI.storeSet({ key: 'scanHistory', value: next });
          return next;
        });

        // Parental Control Checks
        data.devices.forEach(d => {
          const pc = parentalControls[d.mac];
          if (pc && pc.enabled) {
            const isRestricted = pc.after < pc.before
              ? (nowStr >= pc.after && nowStr <= pc.before)
              : (nowStr >= pc.after || nowStr <= pc.before);

            if (isRestricted) {
              const lastNotified = notifiedRestrictions[d.mac] || 0;
              if (nowTs - lastNotified > 1800000) { // Notify once every 30 mins
                window.electronAPI.sendNotification({
                  title: '⚠️ CẢNH BÁO GIỜ GIỚI HẠN',
                  body: `Thiết bị ${customNames[d.mac] || d.name || d.ip} đang online trong giờ giới hạn (${nowStr})!`
                });
                setNotifiedRestrictions(prev => ({ ...prev, [d.mac]: nowTs }));
              }
            }
          }
        });

        if (newlyFound.length > 0 && enableNotifications) {
          window.electronAPI.sendNotification({
            title: 'Thiết bị mới',
            body: `Phát hiện ${newlyFound.length} thiết bị mới tham gia mạng.`
          });
        }

        setNewlyDetected(newlyFound.map(d => d.mac));
        setLostDevices(missing.map(d => d.mac));

        // Update latency history
        setLatencyHistory(prev => {
          const next = { ...prev };
          data.devices.forEach(d => {
            if (d.latency) {
              if (!next[d.mac]) next[d.mac] = [];
              next[d.mac].push({ time: new Date().toLocaleTimeString(), value: d.latency });
              if (next[d.mac].length > 100) next[d.mac].shift();
            }
          });
          return next;
        });

        setDevices(
          data.devices.map((d) => {
            const existing = devices.find(old => old.mac === d.mac);
            return {
              ...d,
              vendor: existing?.vendor || "Đang tải...",
              services: existing?.services || [],
              enriched: existing?.enriched || false,
            };
          }),
        );

        setLastScanTime(new Date().toLocaleTimeString());
        setTimeout(() => {
          setNewlyDetected([]);
          setLostDevices([]);
        }, 10000);
      } else {
        throw new Error(data.error || "Lỗi quét mạng");
      }
    } catch (err) {
      setError(err.message || "Không thể kết nối đến service quét mạng.");
    } finally {
      setLoading(false);
    }
  };

  const handleRename = async (mac, newName) => {
    const updated = { ...customNames, [mac]: newName };
    setCustomNames(updated);
    await window.electronAPI.storeSet({ key: 'customNames', value: updated });
  };

  const toggleParentalControl = async (mac, settings) => {
    const updated = { ...parentalControls, [mac]: settings };
    setParentalControls(updated);
    await window.electronAPI.storeSet({ key: 'parentalControls', value: updated });
  };

  const exportCSV = () => {
    const headers = "IP,MAC,Tên,Vendor,Latency,Status\n";
    const rows = devices.map(d =>
      `${d.ip},${d.mac},"${customNames[d.mac] || d.name || ''}","${d.vendor}",${d.latency},Online`
    ).join("\n");

    const blob = new Blob([headers + rows], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.setAttribute('hidden', '');
    a.setAttribute('href', url);
    a.setAttribute('download', `netscan_report_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };


  // Auto-scan logic
  useEffect(() => {
    let timer;
    if (autoScan && !loading) {
      timer = setInterval(() => {
        scanNetwork();
      }, scanInterval);
    }
    return () => clearInterval(timer);
  }, [autoScan, scanInterval, loading]);

  const stopScan = async () => {
    await window.electronAPI.stopScan();
    setLoading(false);
  };

  // Sequential enrichment of device info
  useEffect(() => {
    const enrichNextDevice = async () => {
      const nextToEnrich = devices.find((d) => !d.enriched);

      if (!nextToEnrich && !loading && devices.length > 0 && !reportSent) {
        setReportSent(true);
        if (window.electronAPI.sendScanReport) {
          window.electronAPI.sendScanReport(devices).catch(console.error);
        }
        return;
      }

      if (!nextToEnrich || loading) return;

      try {
        const info = await window.electronAPI.getDeviceInfo({
          ip: nextToEnrich.ip,
          mac: nextToEnrich.mac,
          name: nextToEnrich.name
        });
        setDevices((prev) =>
          prev.map((d) =>
            d.mac === nextToEnrich.mac
              ? {
                ...d,
                ...info,
                name: info.resolvedName && info.resolvedName !== d.ip ? info.resolvedName : d.name,
                enriched: true
              }
              : d,
          ),
        );
      } catch {
        setDevices((prev) =>
          prev.map((d) =>
            d.mac === nextToEnrich.mac
              ? { ...d, enriched: true, vendor: "Unknown" }
              : d,
          ),
        );
      }
    };

    enrichNextDevice();
  }, [devices, loading]);

  const filteredDevices = useMemo(
    () =>
      devices.filter(
        (d) =>
          d.ip.toLowerCase().includes(searchTerm.toLowerCase()) ||
          (d.name && d.name.toLowerCase().includes(searchTerm.toLowerCase())) ||
          (d.mac && d.mac.toLowerCase().includes(searchTerm.toLowerCase())) ||
          (d.vendor &&
            d.vendor.toLowerCase().includes(searchTerm.toLowerCase())),
      ),
    [devices, searchTerm],
  );

  const avgLatency = useMemo(() => {
    const enriched = devices.filter((d) => d.latency);
    if (enriched.length === 0) return "--";
    return (
      Math.round(
        enriched.reduce((acc, d) => acc + d.latency, 0) / enriched.length,
      ) + "ms"
    );
  }, [devices]);

  return (
    <div className="app-container">
      <div className="bg-glow bg-glow-1"></div>
      <div className="bg-glow bg-glow-2"></div>

      <header className="header">
        <div className="logo">
          <div className="logo-icon">
            <Wifi size={24} color="#6366f1" />
          </div>
          <h1>
            Net<span>Scan</span> Pro
          </h1>
        </div>

        <div className="header-actions">
          <div className="monitoring-controls">
            <label className="switch">
              <input
                type="checkbox"
                checked={autoScan}
                onChange={(e) => setAutoScan(e.target.checked)}
              />
              <span className="slider round"></span>
            </label>
            <span className="control-label">Giám sát tự động</span>

            <select
              value={scanInterval}
              onChange={(e) => setScanInterval(parseInt(e.target.value))}
              className="interval-select"
            >
              <option value={30000}>30 giây</option>
              <option value={60000}>1 phút</option>
              <option value={300000}>5 phút</option>
            </select>
          </div>

          {lastScanTime && (
            <span className="last-scan">Lần quét cuối: {lastScanTime}</span>
          )}
          {!loading ? (
            <button className="btn-primary" onClick={scanNetwork}>
              <RefreshCw size={18} />
              Quét mạng
            </button>
          ) : (
            <button className="btn-danger" onClick={stopScan}>
              <Loader2 size={18} className="spin" />
              Dừng quét
            </button>
          )}
          <button style={{ display: 'flex', alignItems: 'center', gap: '5px' }} className="btn-secondary" onClick={exportCSV}>
            <FileDown size={18} />
            Export CSV
          </button>
        </div>
      </header>

      <main className="dashboard">
        <section className="settings-summary">
          <div className={`status-pill ${autoScan ? 'active' : ''}`}>
            <Activity size={14} />
            {autoScan ? `Tự động quét mỗi ${scanInterval / 1000}s` : 'Chế độ quét thủ công'}
          </div>
          <div className="notification-toggle" onClick={() => setEnableNotifications(!enableNotifications)}>
            <AlertCircle size={14} color={enableNotifications ? '#10b981' : '#64748b'} />
            Thông báo: {enableNotifications ? 'BẬT' : 'TẮT'}
          </div>
        </section>

        {loading && (
          <section className="progress-section" style={{ marginBottom: '1.5rem' }}>
            <div className="progress-info" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem', fontSize: '0.85rem' }}>
              <span>Đang khám phá thiết bị: {progress.current} / {progress.total} IP</span>
              <span>{progress.percent}%</span>
            </div>
            <div className="progress-bar-bg" style={{ height: '6px', background: 'rgba(255,255,255,0.05)', borderRadius: '10px', overflow: 'hidden' }}>
              <motion.div
                className="progress-bar-fill"
                style={{ height: '100%', background: 'linear-gradient(90deg, #6366f1, #a855f7)' }}
                initial={{ width: 0 }}
                animate={{ width: `${progress.percent}%` }}
              />
            </div>
          </section>
        )}

        <section className="controls-panel">

          <div className="search-wrapper" style={{ width: '100%', maxWidth: 'none' }}>
            <Search className="search-icon" size={18} />
            <input
              type="text"
              placeholder="Tìm kiếm nhanh thiết bị (IP, MAC, Tên, Vendor)..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
        </section>

        <section className="stats-row">

          <div className="stat-card">
            <div className="stat-icon">
              <Activity size={20} />
            </div>
            <div className="stat-content">
              <p className="stat-label">Tổng số thiết bị</p>
              <h3 className="stat-value">{devices.length}</h3>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon">
              <Wifi size={20} />
            </div>
            <div className="stat-content">
              <p className="stat-label">Latency trung bình</p>
              <h3 className="stat-value">{avgLatency}</h3>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon">
              <ShieldCheck size={20} color="#10b981" />
            </div>
            <div className="stat-content">
              <p className="stat-label">Trạng thái mạng</p>
              <h3 className="stat-value">Ổn định</h3>
            </div>
          </div>
        </section>

        {/* Tab Navigation */}
        <div className="tab-nav">
          <button className={`tab-btn ${activeTab === 'devices' ? 'active' : ''}`} onClick={() => setActiveTab('devices')}>
            <Monitor size={15} /> Danh sách thiết bị
          </button>
          <button className={`tab-btn ${activeTab === 'timeline' ? 'active' : ''}`} onClick={() => setActiveTab('timeline')}>
            <BarChart2 size={15} /> Timeline hoạt động
          </button>
          <button className={`tab-btn ${activeTab === 'stats' ? 'active' : ''}`} onClick={() => setActiveTab('stats')}>
            <PieChart size={15} /> Thời gian sử dụng
          </button>
        </div>

        {activeTab === 'devices' && (
          <section className="table-container">
            {error && (
              <div className="error-state">
                <AlertCircle size={40} color="#ef4444" />
                <h3>Rất tiếc! Đã có lỗi xảy ra</h3>
                <p>{error}</p>
                <button className="btn-secondary" onClick={scanNetwork}>
                  Thử lại
                </button>
              </div>
            )}

            {!error && !loading && devices.length === 0 && (
              <div className="empty-state" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', placeItems: 'center', justifyContent: 'center', marginTop: '50px' }}>
                <Monitor size={40} color="#64748b" />
                <h3>Không tìm thấy thiết bị nào</h3>
                <p>Nhấn nút "Quét mạng" để khám phá các thiết bị trong mạng nội bộ.</p>
              </div>
            )}

            {loading && devices.length === 0 && (
              <div className="loading-state">
                <h3 style={{ textAlign: "center", marginTop: '50px' }}>
                  Đang khám phá thiết bị...
                </h3>
              </div>
            )}

            {devices.length > 0 && (
              <>
                <table className="devices-table">
                  <thead>
                    <tr>
                      <th>Thiết bị & Vendor</th>
                      <th>Địa chỉ IP</th>
                      <th>Hệ điều hành</th>
                      <th>Latency</th>
                      <th>Dịch vụ</th>
                      <th className="action-col">Thao tác</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredDevices.map((device) => (
                      <motion.tr
                        key={device.mac}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className={`${newlyDetected.includes(device.mac) ? "new-device" : ""} ${lostDevices.includes(device.mac) ? "lost-device" : ""}`}
                      >
                        <td>
                          <div className="device-info">
                            <div className="device-icon">{getDeviceIcon(device, customNames)}</div>
                            <div>
                              <div
                                className="device-name clickable"
                                onDoubleClick={() => {
                                  const newName = prompt("Nhập tên gợi nhớ cho thiết bị:", customNames[device.mac] || device.name);
                                  if (newName !== null) handleRename(device.mac, newName);
                                }}
                              >
                                {customNames[device.mac] || device.name}
                                {device.hostname && <span className="hostname-text"> ({device.hostname})</span>}
                                <Edit2 size={10} className="edit-hint" />
                              </div>
                              <div className="device-vendor-os">
                                {device.enriched ? (
                                  <span className="vendor-text">{device.vendor}</span>
                                ) : (
                                  <span className="enrich-loading">
                                    <Loader2 size={10} className="spin" /> Đang cập nhật...
                                  </span>
                                )}
                              </div>
                            </div>
                            {newlyDetected.includes(device.mac) && (
                              <span className="badge-new">MỚI</span>
                            )}
                          </div>
                        </td>
                        <td><code>{device.ip}</code></td>
                        <td>
                          <div className="os-badge-wrapper">
                            <span className="os-badge">{device.os || 'Unknown'}</span>
                          </div>
                        </td>
                        <td>
                          <div className="quality-cell">
                            <div
                              className="quality-dot live-dot"
                              style={{ background: getQualityColor(device.latency) }}
                            ></div>
                            <span className="latency-text">
                              {device.latency != null ? `${device.latency}ms` : "N/A"}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div className="service-tags">
                            {device.enriched ? (
                              device.services?.slice(0, 3).map((s) => (
                                <span key={s.port} className="service-tag">{s.service.split(' ')[0]}</span>
                              ))
                            ) : (
                              <Loader2 size={14} className="spin text-muted" />
                            )}
                            {device.services?.length > 3 && <span className="service-tag">+{device.services.length - 3}</span>}
                          </div>
                        </td>
                        <td className="action-col">
                          <button
                            className="btn-icon"
                            onClick={() => setSelectedDevice(device)}
                          >
                            <ChevronRight size={18} />
                          </button>
                        </td>
                      </motion.tr>
                    ))}
                  </tbody>
                </table>

                {/* Mobile View */}
                <div className="mobile-list">
                  {filteredDevices.map((device) => (
                    <div key={`mob-${device.mac}`} className="device-card-mobile">
                      <div className="device-card-header">
                        <div className="device-icon">{getDeviceIcon(device)}</div>
                        <div>
                          <div className="device-name">{device.name}</div>
                          <div className="device-vendor-os">{device.vendor}</div>
                        </div>
                      </div>
                      <div className="device-card-meta">
                        <span>{device.ip}</span>
                        <span style={{ color: getQualityColor(device.latency) }}>
                          {device.latency ? `${device.latency}ms` : 'N/A'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        {/* Usage Stats View */}
        {activeTab === 'stats' && (
          <section className="timeline-section">
            <div className="gantt-header">
              <h3><PieChart size={16} /> Thống kê thời gian dùng mạng trong ngày</h3>
              <p className="gantt-desc">Tổng thời gian online của từng thiết bị kể từ 0h sáng nay</p>
            </div>
            {devices.length === 0 ? (
              <div className="empty-state" style={{ marginTop: '2rem' }}>
                <PieChart size={40} color="#64748b" />
                <h3>Chưa có dữ liệu</h3>
              </div>
            ) : (
              <div className="stats-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: '1rem', marginTop: '1rem' }}>
                {devices.map(device => {
                  const usageMs = getDailyUsage(device.mac, scanHistory);
                  return (
                    <div key={device.mac} className="stat-card" style={{ flexDirection: 'column', alignItems: 'flex-start', padding: '1.25rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
                        <div className="device-icon" style={{ padding: '0.5rem', background: 'rgba(255,255,255,0.05)', borderRadius: '8px' }}>
                          {getDeviceIcon(device, customNames)}
                        </div>
                        <div>
                          <div className="device-name" style={{ fontSize: '0.9rem', fontWeight: '600' }}>{customNames[device.mac] || device.name}</div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{device.ip}</div>
                        </div>
                      </div>
                      <div style={{ background: 'rgba(0,0,0,0.2)', padding: '0.75rem', borderRadius: '8px', width: '100%' }}>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>Thời gian Online hôm nay</div>
                        <div style={{ fontSize: '1.25rem', fontWeight: '700', color: 'var(--primary)' }}>
                          {formatDuration(usageMs)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* Timeline / Gantt View */}
        {activeTab === 'timeline' && (
          <section className="timeline-section">
            <div className="gantt-header">
              <h3><Clock size={16} /> Timeline hoạt động thiết bị (24 giờ)
              </h3>
              <p className="gantt-desc">Phân tích thói quen sử dụng mạng theo thời gian</p>
            </div>
            {Object.keys(scanHistory).length === 0 ? (
              <div className="empty-state" style={{ marginTop: '2rem' }}>
                <BarChart2 size={40} color="#64748b" />
                <h3>Chưa có dữ liệu</h3>
                <p>Quét mạng nhiều lần để xây dựng biểu đồ timeline.</p>
              </div>
            ) : (
              <div className="gantt-chart">
                {/* Hour ruler */}
                <div className="gantt-row gantt-ruler">
                  <div className="gantt-label"></div>
                  <div className="gantt-track">
                    {Array.from({ length: 25 }, (_, i) => (
                      <span key={i} className="gantt-hour-mark" style={{ left: `${(i / 24) * 100}%` }}>
                        {String(i).padStart(2, '0')}
                      </span>
                    ))}
                  </div>
                </div>
                {/* Device rows */}
                {Object.entries(scanHistory).map(([mac, events]) => {
                  const deviceName = customNames[mac] || devices.find(d => d.mac === mac)?.name || mac;
                  const pc = parentalControls[mac];
                  // Build online segments for today
                  const today = new Date();
                  today.setHours(0, 0, 0, 0);
                  const dayStart = today.getTime();
                  const dayEnd = dayStart + 86400000;

                  const todayEvents = events.filter(e => e.ts >= dayStart && e.ts < dayEnd);
                  const segments = [];
                  let onlineStart = null;
                  todayEvents.forEach(e => {
                    if (e.event === 'Online') onlineStart = e.ts;
                    else if (e.event === 'Offline' && onlineStart) {
                      segments.push({ start: onlineStart, end: e.ts });
                      onlineStart = null;
                    }
                  });
                  if (onlineStart) segments.push({ start: onlineStart, end: Date.now() });

                  if (segments.length === 0 && todayEvents.length === 0) return null;

                  return (
                    <div key={mac} className="gantt-row">
                      <div className="gantt-label">
                        <span className="gantt-device-name">{deviceName}</span>
                        {pc?.enabled && <Clock size={11} color="#f59e0b" title="Parental Control" />}
                      </div>
                      <div className="gantt-track">
                        {/* Restricted zone overlay */}
                        {pc?.enabled && (() => {
                          const afterH = parseInt(pc.after.split(':')[0]) + parseInt(pc.after.split(':')[1]) / 60;
                          const beforeH = parseInt(pc.before.split(':')[0]) + parseInt(pc.before.split(':')[1]) / 60;
                          return (
                            <div className="gantt-restricted-zone" style={{
                              left: `${(afterH / 24) * 100}%`,
                              width: `${((beforeH - afterH + 24) % 24 / 24) * 100}%`
                            }} />
                          );
                        })()}
                        {/* Online segments */}
                        {segments.map((seg, i) => {
                          const leftPct = ((seg.start - dayStart) / 86400000) * 100;
                          const widthPct = ((seg.end - seg.start) / 86400000) * 100;
                          return (
                            <div key={i} className="gantt-bar" style={{ left: `${leftPct}%`, width: `${Math.max(widthPct, 0.5)}%` }} />
                          );
                        })}
                        {/* Current time marker */}
                        <div className="gantt-now-marker" style={{ left: `${((Date.now() - dayStart) / 86400000) * 100}%` }} />
                      </div>
                    </div>
                  );
                }).filter(Boolean)}
              </div>
            )}
          </section>
        )}

      </main>

      <AnimatePresence>
        {selectedDevice && (
          <div className="modal-overlay" onClick={() => setSelectedDevice(null)}>
            <motion.div
              className="modal-content"
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-header">
                <div className="modal-title-group">
                  <div className="modal-icon-bg">{getDeviceIcon(selectedDevice, customNames)}</div>
                  <div>
                    <h2>Chi tiết thiết bị</h2>
                    <p className="modal-subtitle">{selectedDevice.ip}</p>
                  </div>
                </div>
                <button className="btn-close" onClick={() => setSelectedDevice(null)}>&times;</button>
              </div>
              <div className="modal-body">
                <div className="detail-grid">
                  <div className="detail-item">
                    <label>Tên hiển thị</label>
                    <div className="detail-value-row">
                      <span>{customNames[selectedDevice.mac] || selectedDevice.name || 'N/A'}</span>
                      <button className="btn-mini" onClick={() => {
                        const newName = prompt("Nhập tên mới:", customNames[selectedDevice.mac] || selectedDevice.name);
                        if (newName !== null) handleRename(selectedDevice.mac, newName);
                      }}>Sửa</button>
                    </div>
                  </div>
                  {selectedDevice.hostname && (
                    <div className="detail-item">
                      <label>Hostname (DNS)</label>
                      <span>{selectedDevice.hostname}</span>
                    </div>
                  )}
                  <div className="detail-item">
                    <label>Địa chỉ IP</label>
                    <div className="detail-value-row">
                      <code>{selectedDevice.ip}</code>
                      <button className="btn-mini" onClick={() => navigator.clipboard.writeText(selectedDevice.ip)}>Copy</button>
                    </div>
                  </div>
                  <div className="detail-item">
                    <label>Địa chỉ MAC</label>
                    <div className="detail-value-row">
                      <code>{selectedDevice.mac}</code>
                      <button className="btn-mini" onClick={() => navigator.clipboard.writeText(selectedDevice.mac)}>Copy</button>
                    </div>
                  </div>
                  <div className="detail-item">
                    <label>Nhà sản xuất</label>
                    <span>{selectedDevice.vendor}</span>
                  </div>
                  <div className="detail-item">
                    <label>MAC Prefix</label>
                    <code>{selectedDevice.mac?.substring(0, 8).toUpperCase()}</code>
                  </div>
                  <div className="detail-item">
                    <label>Loại thiết bị</label>
                    <span className="type-badge">{selectedDevice.deviceType || 'PC'}</span>
                  </div>
                  <div className="detail-item">
                    <label>Hệ điều hành</label>
                    <span className="os-badge">{selectedDevice.os || 'Unknown'}</span>
                  </div>
                </div>

                <div className="detail-section">
                  <div className="section-header">
                    <h3>Hiệu năng & Kết nối</h3>
                    <span className="latency-badge" style={{ color: getQualityColor(selectedDevice.latency) }}>
                      {selectedDevice.latency != null ? `${selectedDevice.latency}ms` : 'Offline'}
                    </span>
                  </div>
                </div>

                {selectedDevice.services?.length > 0 && (
                  <div className="detail-section">
                    <h3>Dịch vụ phát hiện ({selectedDevice.services.length})</h3>
                    <div className="services-list">
                      {selectedDevice.services.map((s, idx) => (
                        <div key={idx} className="service-row">
                          <span className="port-label">{s.port}</span>
                          <span className="service-desc">{s.service}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {selectedDevice.bonjour?.length > 0 && (
                  <div className="detail-section">
                    <h3>Dữ liệu mDNS / Bonjour</h3>
                    <div className="bonjour-cards">
                      {selectedDevice.bonjour.map((b, idx) => (
                        <div key={idx} className="bonjour-card">
                          <div className="bonjour-header">
                            <span className="bonjour-name">{b.name}</span>
                            <span className="bonjour-type">{b.type}</span>
                          </div>
                          {b.txt && Object.keys(b.txt).length > 0 && (
                            <div className="bonjour-txt">
                              {Object.entries(b.txt).map(([k, v]) => (
                                <div key={k} className="txt-item">
                                  <strong>{MDNS_LABELS[k] || k}:</strong> {String(v)}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {scanHistory[selectedDevice.mac] && (
                  <div className="detail-section">
                    <h3>Lịch sử hoạt động</h3>

                    {/* Single Device Gantt Chart */}
                    <div className="gantt-chart" style={{ marginBottom: '1.5rem', background: 'rgba(0,0,0,0.1)', padding: '1rem', borderRadius: '12px' }}>
                      <div className="gantt-row gantt-ruler">
                        <div className="gantt-label" style={{ width: '60px' }}></div>
                        <div className="gantt-track" style={{ minWidth: '100%' }}>
                          {Array.from({ length: 7 }, (_, i) => (
                            <span key={i} className="gantt-hour-mark" style={{ left: `${(i * 4 / 24) * 100}%` }}>
                              {String(i * 4).padStart(2, '0')}h
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="gantt-row" style={{ minHeight: '20px' }}>
                        <div className="gantt-label" style={{ width: '60px' }}>
                          <span className="gantt-device-name" style={{ fontSize: '0.75rem' }}>Hôm nay</span>
                        </div>
                        <div className="gantt-track" style={{ minWidth: '100%' }}>
                          {(() => {
                            const pc = parentalControls[selectedDevice.mac];
                            const today = new Date();
                            today.setHours(0, 0, 0, 0);
                            const dayStart = today.getTime();
                            const dayEnd = dayStart + 86400000;
                            const events = scanHistory[selectedDevice.mac] || [];
                            const todayEvents = events.filter(e => e.ts >= dayStart && e.ts < dayEnd);
                            const segments = [];
                            let onlineStart = null;
                            todayEvents.forEach(e => {
                              if (e.event === 'Online') onlineStart = e.ts;
                              else if (e.event === 'Offline' && onlineStart) {
                                segments.push({ start: onlineStart, end: e.ts });
                                onlineStart = null;
                              }
                            });
                            if (onlineStart) segments.push({ start: onlineStart, end: Date.now() });

                            return (
                              <>
                                {pc?.enabled && (() => {
                                  const afterH = parseInt(pc.after.split(':')[0]) + parseInt(pc.after.split(':')[1]) / 60;
                                  const beforeH = parseInt(pc.before.split(':')[0]) + parseInt(pc.before.split(':')[1]) / 60;
                                  return (
                                    <div className="gantt-restricted-zone" style={{
                                      left: `${(afterH / 24) * 100}%`,
                                      width: `${((beforeH - afterH + 24) % 24 / 24) * 100}%`
                                    }} />
                                  );
                                })()}
                                {segments.map((seg, i) => {
                                  const leftPct = ((seg.start - dayStart) / 86400000) * 100;
                                  const widthPct = ((seg.end - seg.start) / 86400000) * 100;
                                  return <div key={i} className="gantt-bar" style={{ left: `${leftPct}%`, width: `${Math.max(widthPct, 0.5)}%` }} />
                                })}
                                <div className="gantt-now-marker" style={{ left: `${((Date.now() - dayStart) / 86400000) * 100}%` }} />
                              </>
                            );
                          })()}
                        </div>
                      </div>
                    </div>

                    <div className="history-timeline">
                      {(() => {
                        const history = scanHistory[selectedDevice.mac] || [];
                        if (history.length === 0) return <p className="text-muted">Chưa có lịch sử hoạt động.</p>;

                        // Group by date
                        const groups = {};
                        history.forEach(h => {
                          const d = h.time.split(' ')[0];
                          if (!groups[d]) groups[d] = [];
                          groups[d].push(h);
                        });

                        return Object.entries(groups).reverse().slice(0, 3).map(([date, items], gIdx) => (
                          <div key={gIdx} className="history-group">
                            <div className="history-date-header">{date === new Date().toLocaleDateString('vi-VN') ? 'Hôm nay' : date}</div>
                            <div className="history-items">
                              {items.reverse().map((h, idx) => (
                                <div key={idx} className="timeline-item">
                                  <div className={`timeline-dot ${h.event.toLowerCase()}`}></div>
                                  <div className="timeline-content">
                                    <div className="timeline-main">
                                      <span className="timeline-event">
                                        <b>{customNames[selectedDevice.mac] || selectedDevice.name || selectedDevice.ip}</b>: {h.event === 'Online' ? 'Kết nối' : 'Mất kết nối'}
                                      </span>
                                      <span className="timeline-time">{h.time.split(' ')[1]}</span>
                                    </div>
                                    <div className="timeline-connector"></div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ));
                      })()}
                    </div>
                  </div>
                )}

                {/* Parental Control Section */}
                <div className="detail-section">
                  <div className="section-header">
                    <h3><Clock size={14} style={{ display: 'inline', marginRight: '0.4rem' }} />Điều khiển phụ huynh</h3>
                    <label className="pc-toggle">
                      <input
                        type="checkbox"
                        checked={parentalControls[selectedDevice.mac]?.enabled || false}
                        onChange={(e) => toggleParentalControl(selectedDevice.mac, {
                          ...(parentalControls[selectedDevice.mac] || { after: '22:00', before: '06:00' }),
                          enabled: e.target.checked
                        })}
                      />
                      <span className="pc-slider"></span>
                    </label>
                  </div>
                  {parentalControls[selectedDevice.mac]?.enabled && (
                    <div className="pc-config">
                      <p className="pc-desc">⚠️ Cảnh báo nếu thiết bị online trong giờ giới hạn</p>
                      <div className="pc-time-row">
                        <div className="pc-time-group">
                          <label>Từ giờ</label>
                          <input
                            type="time"
                            className="pc-time-input"
                            value={parentalControls[selectedDevice.mac]?.after || '22:00'}
                            onChange={(e) => toggleParentalControl(selectedDevice.mac, {
                              ...parentalControls[selectedDevice.mac],
                              after: e.target.value
                            })}
                          />
                        </div>
                        <span className="pc-arrow">→</span>
                        <div className="pc-time-group">
                          <label>Đến giờ</label>
                          <input
                            type="time"
                            className="pc-time-input"
                            value={parentalControls[selectedDevice.mac]?.before || '06:00'}
                            onChange={(e) => toggleParentalControl(selectedDevice.mac, {
                              ...parentalControls[selectedDevice.mac],
                              before: e.target.value
                            })}
                          />
                        </div>
                      </div>
                      <div className="pc-stats">
                        <div className="pc-stat">
                          <span>Tổng phiên hôm nay</span>
                          <strong>{scanHistory[selectedDevice.mac]?.filter(e => {
                            const today = new Date(); today.setHours(0, 0, 0, 0);
                            return e.ts >= today.getTime() && e.event === 'Online';
                          }).length || 0} phiên</strong>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div className="modal-footer">
                  <p className="last-update">Cập nhật lần cuối: {new Date().toLocaleTimeString()}</p>
                  {selectedDevice.enriched && (
                    <span className="verified-tag">
                      <ShieldCheck size={14} /> Thông tin đã xác thực
                    </span>
                  )}
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <footer className="footer">
        <p>&copy; 2026 NetScan Discovery Utility. Phát triển bởi VanThiet</p>
      </footer>
    </div>
  );
};

export default App;
