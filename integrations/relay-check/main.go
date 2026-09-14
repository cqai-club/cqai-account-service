// Run inside the pinned cqai-relay checkout; uses its real Sobek plugin runtime.
package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"

	"github.com/QuantumNous/new-api/pkg/jsplugin"
)

func main() {
	source, err := os.ReadFile(os.Args[1])
	check(err)
	plugin, err := jsplugin.CompilePlugin(string(source), jsplugin.Options{})
	check(err)
	check(jsplugin.ValidateV1Meta(plugin.Meta))
	envelope := `{"avatar_id":"a1","voice_id":"v1","script_text":"test","seconds":10,"request_id":"r1"}`
	mac := hmac.New(sha256.New, []byte("fixture-key"))
	mac.Write([]byte(envelope))
	ctx := map[string]any{"baseUrl": "https://fixture.invalid/openapi/v1", "apiKey": "fixture-key", "requestBody": map[string]any{"envelope": envelope, "signature": hex.EncodeToString(mac.Sum(nil))}}
	value, err := plugin.Engine.Call(context.Background(), "buildSubmitRequest", ctx)
	check(err)
	encoded, err := json.Marshal(value)
	check(err)
	var request map[string]any
	check(json.Unmarshal(encoded, &request))
	if request["url"] != "https://fixture.invalid/openapi/v1/skills/digital_human_standard/runs" { panic("unexpected submit URL") }
	body := map[string]any{"status": "completed", "outputs": []any{map[string]any{"name": "video", "duration_seconds": 13.2}}}
	value, err = plugin.Engine.Call(context.Background(), "extractUsageOnComplete", nil, map[string]any{"status": "SUCCESS"}, body)
	check(err)
	encoded, err = json.Marshal(value)
	check(err)
	if string(encoded) != `{"seconds":14}` { panic("unexpected completion usage") }
	ctx["requestBody"] = map[string]any{"envelope": envelope, "signature": "invalid"}
	_, err = plugin.Engine.Call(context.Background(), "buildSubmitRequest", ctx)
	if err == nil { panic("unsigned request accepted") }
	fmt.Println("PASS: Relay metadata, real JS runtime, HMAC authorization, submission descriptor and actual-duration billing facts")
}

func check(err error) { if err != nil { panic(err) } }
