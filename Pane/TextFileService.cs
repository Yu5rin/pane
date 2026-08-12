using System.Text;

namespace Pane;

/// <summary>
/// 仕様書 第6章で定めるエンコーディング。既定はUTF-8(BOMなし)。
/// </summary>
internal enum FileEncodingKind
{
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    ShiftJis,
}

/// <summary>
/// 仕様書 第6.2節で定める改行コード。複数種が混在する場合は Mixed。
/// </summary>
internal enum LineEndingKind
{
    Crlf,
    Lf,
    Cr,
    Mixed,
}

/// <summary>
/// ファイルを開いた結果。Text は改行コードを "\n" に正規化した本文(エディタへ渡す形)。
/// 元の改行コードは LineEnding に、末尾改行の有無は HasTrailingNewline に保持し、
/// 保存時に復元する。
/// </summary>
internal sealed record LoadResult(
    string Text,
    FileEncodingKind Encoding,
    LineEndingKind LineEnding,
    bool HasTrailingNewline);

/// <summary>
/// ファイルI/O(読み書き・文字コード判定・改行コード判定・アトミック保存)。
/// 仕様書 第6章: ファイルの実体はC#側だけが触る。JS側は本文文字列とモード情報のみを受け取る。
/// </summary>
internal static class TextFileService
{
    private static readonly byte[] Utf8BomBytes = { 0xEF, 0xBB, 0xBF };
    private static readonly byte[] Utf16LeBomBytes = { 0xFF, 0xFE };
    private static readonly byte[] Utf16BeBomBytes = { 0xFE, 0xFF };

    public static LoadResult Load(string path)
    {
        byte[] bytes = File.ReadAllBytes(path);
        FileEncodingKind encoding = DetectEncoding(bytes, out int bomLength);
        string raw = DecodeBody(bytes, bomLength, encoding);

        LineEndingKind lineEnding = DetectLineEnding(raw);
        bool hasTrailingNewline = raw.Length > 0 && (raw.EndsWith("\r\n") || raw.EndsWith('\n') || raw.EndsWith('\r'));
        string normalized = NormalizeToLf(raw);
        if (hasTrailingNewline && normalized.EndsWith('\n'))
        {
            // エディタへ渡す本文には末尾の空行を残さない(末尾改行の有無は別途保持する)
            normalized = normalized[..^1];
        }

        return new LoadResult(normalized, encoding, lineEnding, hasTrailingNewline);
    }

    /// <summary>
    /// 一時ファイル経由でアトミックに保存する。書き込み失敗時は原本を変更しない。
    /// </summary>
    public static void SaveAtomic(
        string path,
        string editorText,
        FileEncodingKind encoding,
        LineEndingKind lineEnding,
        bool hasTrailingNewline)
    {
        string body = DenormalizeFromLf(editorText, lineEnding);
        if (hasTrailingNewline)
        {
            body += LineEndingString(lineEnding);
        }

        byte[] bytes = EncodeBody(body, encoding);

        string directory = Path.GetDirectoryName(Path.GetFullPath(path))
            ?? throw new IOException($"保存先の親フォルダを特定できません: {path}");
        string tempPath = Path.Combine(directory, $".{Path.GetFileName(path)}.pane-tmp-{Guid.NewGuid():N}");

        try
        {
            File.WriteAllBytes(tempPath, bytes);
            // 同一ボリューム内であればアトミックな置き換えとして扱える。
            File.Move(tempPath, path, overwrite: true);
        }
        catch
        {
            TryDelete(tempPath);
            throw;
        }
    }

    private static void TryDelete(string path)
    {
        try { File.Delete(path); } catch { /* ベストエフォート。元ファイルは無事なので握りつぶす */ }
    }

    private static FileEncodingKind DetectEncoding(byte[] bytes, out int bomLength)
    {
        if (StartsWith(bytes, Utf8BomBytes)) { bomLength = Utf8BomBytes.Length; return FileEncodingKind.Utf8Bom; }
        if (StartsWith(bytes, Utf16LeBomBytes)) { bomLength = Utf16LeBomBytes.Length; return FileEncodingKind.Utf16Le; }
        if (StartsWith(bytes, Utf16BeBomBytes)) { bomLength = Utf16BeBomBytes.Length; return FileEncodingKind.Utf16Be; }

        bomLength = 0;

        // BOMが無い場合はUTF-8として厳密デコードを試み、失敗したらShift_JISを試す
        // (日本語環境のため必ず含める。仕様書 第6.1節)。
        var strictUtf8 = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);
        try
        {
            strictUtf8.GetString(bytes);
            return FileEncodingKind.Utf8;
        }
        catch (DecoderFallbackException)
        {
            // UTF-8として不正 → 次にShift_JISを試す
        }

        Encoding strictShiftJis = Encoding.GetEncoding(
            932,
            EncoderFallback.ExceptionFallback,
            DecoderFallback.ExceptionFallback);
        try
        {
            strictShiftJis.GetString(bytes);
            return FileEncodingKind.ShiftJis;
        }
        catch (DecoderFallbackException)
        {
            // Shift_JISとしても不正 → 最終手段としてShift_JISを非厳密デコードで採用する
            // (置換文字が入っても表示自体は継続できるようにする)
            return FileEncodingKind.ShiftJis;
        }
    }

    private static string DecodeBody(byte[] bytes, int bomLength, FileEncodingKind encoding)
    {
        ReadOnlySpan<byte> body = bytes.AsSpan(bomLength);
        return encoding switch
        {
            FileEncodingKind.Utf8Bom => Encoding.UTF8.GetString(body),
            FileEncodingKind.Utf8 => Encoding.UTF8.GetString(body),
            FileEncodingKind.Utf16Le => Encoding.Unicode.GetString(body),
            FileEncodingKind.Utf16Be => Encoding.BigEndianUnicode.GetString(body),
            FileEncodingKind.ShiftJis => Encoding.GetEncoding(932).GetString(body),
            _ => throw new ArgumentOutOfRangeException(nameof(encoding)),
        };
    }

    private static byte[] EncodeBody(string body, FileEncodingKind encoding)
    {
        return encoding switch
        {
            FileEncodingKind.Utf8Bom => Utf8BomBytes.Concat(Encoding.UTF8.GetBytes(body)).ToArray(),
            FileEncodingKind.Utf8 => Encoding.UTF8.GetBytes(body),
            FileEncodingKind.Utf16Le => Utf16LeBomBytes.Concat(Encoding.Unicode.GetBytes(body)).ToArray(),
            FileEncodingKind.Utf16Be => Utf16BeBomBytes.Concat(Encoding.BigEndianUnicode.GetBytes(body)).ToArray(),
            FileEncodingKind.ShiftJis => Encoding.GetEncoding(932).GetBytes(body),
            _ => throw new ArgumentOutOfRangeException(nameof(encoding)),
        };
    }

    private static bool StartsWith(byte[] bytes, byte[] prefix)
    {
        if (bytes.Length < prefix.Length) return false;
        for (int i = 0; i < prefix.Length; i++)
        {
            if (bytes[i] != prefix[i]) return false;
        }
        return true;
    }

    internal static LineEndingKind DetectLineEnding(string text)
    {
        bool sawCrlf = false, sawLf = false, sawCr = false;
        for (int i = 0; i < text.Length; i++)
        {
            if (text[i] == '\r')
            {
                if (i + 1 < text.Length && text[i + 1] == '\n') { sawCrlf = true; i++; }
                else { sawCr = true; }
            }
            else if (text[i] == '\n')
            {
                sawLf = true;
            }
        }

        int kinds = (sawCrlf ? 1 : 0) + (sawLf ? 1 : 0) + (sawCr ? 1 : 0);
        if (kinds > 1) return LineEndingKind.Mixed;
        if (sawCrlf) return LineEndingKind.Crlf;
        if (sawCr) return LineEndingKind.Cr;
        if (sawLf) return LineEndingKind.Lf;

        // 改行が1つも無いファイル(1行のみ)。Windows既定に合わせてCRLF扱いとする。
        return LineEndingKind.Crlf;
    }

    private static string NormalizeToLf(string text)
    {
        return text.Replace("\r\n", "\n").Replace('\r', '\n');
    }

    private static string DenormalizeFromLf(string text, LineEndingKind lineEnding)
    {
        string sep = LineEndingString(lineEnding);
        return sep == "\n" ? text : text.Replace("\n", sep);
    }

    internal static string LineEndingString(LineEndingKind kind) => kind switch
    {
        LineEndingKind.Crlf => "\r\n",
        LineEndingKind.Cr => "\r",
        LineEndingKind.Lf => "\n",
        // 混在ファイルを保存し直す場合はCRLFに統一する(仕様書6.2の「統一操作」に相当する
        // 最小実装。個別の統一UIはPhase 5以降)。
        LineEndingKind.Mixed => "\r\n",
        _ => "\n",
    };

    internal static string EncodingLabel(FileEncodingKind kind) => kind switch
    {
        FileEncodingKind.Utf8 => "UTF-8",
        FileEncodingKind.Utf8Bom => "UTF-8 (BOM付き)",
        FileEncodingKind.Utf16Le => "UTF-16 LE",
        FileEncodingKind.Utf16Be => "UTF-16 BE",
        FileEncodingKind.ShiftJis => "Shift_JIS",
        _ => kind.ToString(),
    };

    internal static string LineEndingLabel(LineEndingKind kind) => kind switch
    {
        LineEndingKind.Crlf => "CRLF",
        LineEndingKind.Lf => "LF",
        LineEndingKind.Cr => "CR",
        LineEndingKind.Mixed => "混在",
        _ => kind.ToString(),
    };
}
