using System.Text.Json;

namespace Pane;

/// <summary>
/// WebView2とのpostMessageブリッジ(JSON)から値を安全に取り出すための共通ヘルパー。
/// JS側から届く値はいずれも「外部入力」であり、型がこちらの想定と違っていても
/// (JS側の不具合・改変・将来の実装ミス等)例外を投げず、呼び出し元へは
/// 「無かった/型が違った」ことをbool戻り値で伝え、outには安全な既定値を入れる。
///
/// 元々は<see cref="SettingsBridge"/>のsave-settings専用ヘルパーとしてのみ存在したが、
/// <see cref="MainForm.OnWebMessageReceived"/>側の各caseでも同種の取り出し(かつ
/// ValueKindを確認しないままGetBoolean()/GetString()/GetInt32()を呼ぶ同じ不具合)が
/// 多数あったため、両方から使えるここへ切り出した。
/// </summary>
internal static class JsonMessageHelpers
{
    /// <summary>プロパティが文字列型で存在すればtrueを返しvalueへ入れる。それ以外(無い/nullを含む型違い)は既定値""でfalse。</summary>
    public static bool TryGetString(JsonElement obj, string name, out string value)
    {
        if (obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out JsonElement prop) && prop.ValueKind == JsonValueKind.String)
        {
            value = prop.GetString() ?? "";
            return true;
        }
        value = "";
        return false;
    }

    /// <summary>プロパティがtrue/falseで存在すればtrueを返しvalueへ入れる。それ以外は既定値falseでfalse。</summary>
    public static bool TryGetBool(JsonElement obj, string name, out bool value)
    {
        if (obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out JsonElement prop) &&
            (prop.ValueKind == JsonValueKind.True || prop.ValueKind == JsonValueKind.False))
        {
            value = prop.GetBoolean();
            return true;
        }
        value = false;
        return false;
    }

    /// <summary>プロパティが32bit整数として解釈できる数値で存在すればtrueを返しvalueへ入れる。それ以外は既定値0でfalse。</summary>
    public static bool TryGetInt(JsonElement obj, string name, out int value)
    {
        if (obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out JsonElement prop) && prop.ValueKind == JsonValueKind.Number &&
            prop.TryGetInt32(out int parsed))
        {
            value = parsed;
            return true;
        }
        value = 0;
        return false;
    }

    /// <summary>プロパティが数値で存在すればtrueを返しvalueへ入れる。それ以外は既定値0でfalse。</summary>
    public static bool TryGetDouble(JsonElement obj, string name, out double value)
    {
        if (obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out JsonElement prop) && prop.ValueKind == JsonValueKind.Number &&
            prop.TryGetDouble(out double parsed))
        {
            value = parsed;
            return true;
        }
        value = 0;
        return false;
    }

    /// <summary>文字列の配列プロパティを読み取る。プロパティが無い・配列でない場合はnullを返す
    /// (「送られてこなければ既存の値を変更しない」という呼び出し元の挙動に合わせるため)。
    /// 配列の要素のうち文字列でないもの・空文字は読み飛ばす。</summary>
    public static List<string>? TryGetStringList(JsonElement obj, string name)
    {
        if (obj.ValueKind != JsonValueKind.Object || !obj.TryGetProperty(name, out JsonElement prop) || prop.ValueKind != JsonValueKind.Array) return null;
        return prop.EnumerateArray()
            .Where(e => e.ValueKind == JsonValueKind.String)
            .Select(e => e.GetString() ?? "")
            .Where(e => e.Length > 0)
            .ToList();
    }

    /// <summary>
    /// 文字列型のプロパティの値、またはプロパティが無い/JSON null/型違いの場合はnullを返す
    /// (呼び出し元がnull許容の文字列フィールド、例: パスのように「無ければnull」を期待する
    /// フィールドを安全に読み取るためのヘルパー。型が違う場合も例外を投げず「値なし」として扱う)。
    /// </summary>
    public static string? TryGetNullableString(JsonElement obj, string name)
    {
        if (obj.ValueKind != JsonValueKind.Object || !obj.TryGetProperty(name, out JsonElement prop)) return null;
        return prop.ValueKind == JsonValueKind.String ? prop.GetString() : null;
    }
}
