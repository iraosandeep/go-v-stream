package main

import (
	"net"
	"net/http"
)

// isLocal reports whether the request comes from someone at this machine. Changing folders or
// browsing the disk is only allowed then: the connection must be loopback, addressed to localhost,
// and not relayed by a tunnel or proxy (ngrok, cloudflared and Tailscale Funnel connect from
// loopback but add forwarding headers).
func isLocal(r *http.Request) bool {
	ipStr, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	if ip := net.ParseIP(ipStr); ip == nil || !ip.IsLoopback() {
		return false
	}
	host := r.Host
	if h, _, err := net.SplitHostPort(r.Host); err == nil {
		host = h
	}
	switch host {
	case "localhost", "127.0.0.1", "::1":
	default:
		return false
	}
	for _, h := range []string{"X-Forwarded-For", "X-Forwarded-Host", "Forwarded", "X-Real-Ip", "Cf-Connecting-Ip"} {
		if r.Header.Get(h) != "" {
			return false
		}
	}
	return true
}
