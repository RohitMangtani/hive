"use client";

import { useEffect, useCallback } from "react";
import type { DaemonMessage } from "@/lib/types";

/**
 * Registers the service worker and manages Web Push subscription.
 *
 * Push subscription lifecycle:
 * 1. SW registers on mount
 * 2. Parent page sends VAPID key via BroadcastChannel when received from daemon WS
 * 3. This component subscribes to push and sends the subscription back
 * 4. Parent page forwards subscription to daemon via WS
 */
export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);
  return null;
}

/**
 * Hook that subscribes to Web Push when a VAPID key is available.
 * Call from the main page component that has access to the WS send function.
 */
export function usePushSubscription(
  send: (msg: DaemonMessage) => boolean,
  vapidKey: string | null,
) {
  const subscribe = useCallback(async (key: string) => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;

    try {
      const reg = await navigator.serviceWorker.ready;

      // Check if already subscribed
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        // Re-send to daemon in case it lost the subscription (restart, etc.)
        const sub = existing.toJSON();
        if (sub.endpoint && sub.keys?.p256dh && sub.keys?.auth) {
          send({
            type: "push_subscribe",
            subscription: {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
            },
            pushLabel: getDeviceLabel(),
          });
        }
        return;
      }

      // Convert VAPID key from base64url to Uint8Array
      const keyBytes = urlBase64ToUint8Array(key);

      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes.buffer as ArrayBuffer,
      });

      const sub = subscription.toJSON();
      if (sub.endpoint && sub.keys?.p256dh && sub.keys?.auth) {
        send({
          type: "push_subscribe",
          subscription: {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
          },
          pushLabel: getDeviceLabel(),
        });
      }
    } catch (err) {
      // Permission denied or not supported — fail silently
      console.log("[push] Subscription failed:", err);
    }
  }, [send]);

  useEffect(() => {
    if (vapidKey) {
      subscribe(vapidKey);
    }
  }, [vapidKey, subscribe]);
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    arr[i] = raw.charCodeAt(i);
  }
  return arr;
}

function getDeviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac/.test(ua)) return "Mac";
  return "Browser";
}
