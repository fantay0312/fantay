// SPDX-License-Identifier: Apache-2.0
// The local MCP configuration for external clients (spec 07 §6.3): the body of the "连接外部工作台（MCP）"
// modal of the film editor's more menu. Loads the config when shown; copying never edits any client.
import { useEffect, useState } from "react";
import { Copy } from "lucide-react";

import { useT } from "../../i18n";
import { Button, Icon } from "../../fantay/ui";
import styles from "./MovieConnection.module.css";

export function MovieConnection() {
  const t = useT();
  const [config, setConfig] = useState("");
  const [loadError, setLoadError] = useState("");
  const [status, setStatus] = useState("");
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/api/movie/integration");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body: unknown = await response.json();
        if (active) setConfig(JSON.stringify(body, null, 2));
      } catch (error) {
        if (active) setLoadError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  const copy = () => {
    void navigator.clipboard
      .writeText(config)
      .then(() => setStatus(t("motion.connection.copied")))
      .catch(() => setStatus(t("motion.connection.clipboardFailed")));
  };
  return (
    <div className={styles.connection} data-testid="movie-connection">
      <p className={styles.copy}>{t("motion.connection.body")}</p>
      <pre className={styles.config}>{config || loadError || t("motion.connection.loading")}</pre>
      <div className={styles.actions}>
        <Button variant="default" size="sm" disabled={!config} onClick={copy}>
          <Icon icon={Copy} size="sm" />
          {t("motion.connection.copy")}
        </Button>
        <span role="status" className={styles.status}>
          {status}
        </span>
      </div>
      <p className={styles.note}>{t("motion.connection.safety")}</p>
    </div>
  );
}
