// yt-dlp 浏览器扩展的 native messaging 启动器
//
// Chromium 的原生消息宿主必须是一个可执行文件，且 manifest 不能带启动参数，
// 所以这里用系统自带的 csc.exe 编一个极小的 exe：它把 stdin/stdout 的原始字节
// 双向中继给 host.js（Node）执行，业务逻辑全部留在 JS 里。
//
// 编译：install.ps1 调用
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /codepage:65001

using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

internal static class Program
{
    private static readonly object LogLock = new object();
    private static string _logPath;

    private static int Main()
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        _logPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ytdlp-browser", "launcher.log");
        try { Directory.CreateDirectory(Path.GetDirectoryName(_logPath)); } catch { }

        Log("launcher start pid=" + Process.GetCurrentProcess().Id);

        string script = Path.Combine(dir, "host.js");
        if (!File.Exists(script))
        {
            Log("ERROR host.js not found: " + script);
            return 3;
        }

        string node = FindNode(dir);
        if (node == null)
        {
            Log("ERROR node.exe not found");
            return 2;
        }
        Log("node=" + node);

        var psi = new ProcessStartInfo(node, "\"" + script + "\"");
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.WorkingDirectory = dir;
        psi.RedirectStandardInput = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.EnvironmentVariables["NODE_NO_WARNINGS"] = "1";

        Process child;
        try
        {
            child = Process.Start(psi);
        }
        catch (Exception ex)
        {
            Log("ERROR start node: " + ex.Message);
            return 4;
        }
        if (child == null)
        {
            Log("ERROR child process is null");
            return 4;
        }

        Stream browserIn = Console.OpenStandardInput();
        Stream browserOut = Console.OpenStandardOutput();
        Stream childIn = child.StandardInput.BaseStream;
        Stream childOut = child.StandardOutput.BaseStream;
        Stream childErr = child.StandardError.BaseStream;

        // 浏览器 -> 宿主：读到 EOF 表示端口已断开，关掉子进程 stdin 让它自己退出
        var up = new Thread(() => Relay(browserIn, childIn, true)) { IsBackground = true };
        // 宿主 -> 浏览器
        var down = new Thread(() => Relay(childOut, browserOut, false)) { IsBackground = true };
        // 宿主 stderr 只进日志，不进协议通道
        var err = new Thread(() => RelayToLog(childErr)) { IsBackground = true };

        up.Start();
        down.Start();
        err.Start();

        child.WaitForExit();
        down.Join(2000);
        try { browserOut.Flush(); } catch { }
        Log("exit code=" + child.ExitCode);
        return child.ExitCode;
    }

    private static void Relay(Stream from, Stream to, bool closeTargetOnEof)
    {
        var buf = new byte[16384];
        try
        {
            for (;;)
            {
                int n = from.Read(buf, 0, buf.Length);
                if (n <= 0) break;
                to.Write(buf, 0, n);
                to.Flush();
            }
        }
        catch (Exception ex)
        {
            Log("relay error: " + ex.Message);
        }
        finally
        {
            if (closeTargetOnEof)
            {
                try { to.Close(); } catch { }
            }
        }
    }

    private static void RelayToLog(Stream from)
    {
        var buf = new byte[8192];
        var sb = new StringBuilder();
        try
        {
            for (;;)
            {
                int n = from.Read(buf, 0, buf.Length);
                if (n <= 0) break;
                sb.Append(Encoding.UTF8.GetString(buf, 0, n));
                if (sb.Length > 8192)
                {
                    Log("child stderr: " + sb.ToString().Trim());
                    sb.Length = 0;
                }
            }
            if (sb.Length > 0) Log("child stderr: " + sb.ToString().Trim());
        }
        catch { }
    }

    private static string FindNode(string dir)
    {
        var candidates = new[]
        {
            Path.Combine(dir, "node.exe"),
            @"C:\Program Files\nodejs\node.exe",
            @"C:\Program Files (x86)\nodejs\node.exe",
        };
        foreach (var c in candidates)
        {
            if (File.Exists(c)) return c;
        }

        string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        foreach (var p in pathEnv.Split(';'))
        {
            if (p.Trim().Length == 0) continue;
            try
            {
                string full = Path.Combine(p.Trim(), "node.exe");
                if (File.Exists(full)) return full;
            }
            catch { }
        }
        return null;
    }

    private static void Log(string message)
    {
        lock (LogLock)
        {
            try
            {
                File.AppendAllText(
                    _logPath,
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + message + Environment.NewLine,
                    Encoding.UTF8);
            }
            catch { }
        }
    }
}
