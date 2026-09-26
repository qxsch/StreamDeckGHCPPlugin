# Long-lived helper for the Copilot Agents Stream Deck plugin.
# Reads one command per line on stdin and writes one JSON object per line on stdout.
#   LIST         -> {"ok":true,"windows":[{"h":<hwnd>,"pid":<pid>,"app":"Code","t":"<title>"}]}
#   FOCUS <hwnd> -> {"ok":true|false}
#   PING         -> {"ok":true}
# Add-Type is compiled with the .NET Framework CodeDOM compiler, so the C# below must
# stay within C# 5 syntax (no interpolation, no out-var, no expression-bodied members).

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class SdWin
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint attachTo, uint attachFrom, bool attach);
    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    public static List<object[]> List()
    {
        List<object[]> found = new List<object[]>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            if (!IsWindowVisible(hWnd)) { return true; }
            int length = GetWindowTextLength(hWnd);
            if (length == 0) { return true; }
            StringBuilder sb = new StringBuilder(length + 1);
            GetWindowText(hWnd, sb, sb.Capacity);
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            found.Add(new object[] { hWnd.ToInt64(), (int)pid, sb.ToString() });
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static bool Focus(long handle)
    {
        IntPtr hWnd = new IntPtr(handle);
        if (IsIconic(hWnd)) { ShowWindow(hWnd, 9); } else { ShowWindow(hWnd, 5); }

        // A background process cannot normally steal focus; borrowing the foreground
        // thread's input queue is the standard way around that restriction.
        IntPtr foreground = GetForegroundWindow();
        uint ignored;
        uint foregroundThread = GetWindowThreadProcessId(foreground, out ignored);
        uint currentThread = GetCurrentThreadId();
        bool attached = false;
        if (foregroundThread != 0 && foregroundThread != currentThread)
        {
            attached = AttachThreadInput(currentThread, foregroundThread, true);
        }

        BringWindowToTop(hWnd);
        bool ok = SetForegroundWindow(hWnd);
        if (!ok) { SwitchToThisWindow(hWnd, true); ok = GetForegroundWindow() == hWnd; }

        if (attached) { AttachThreadInput(currentThread, foregroundThread, false); }
        return ok;
    }
}
'@

function Write-Json($object) {
    [Console]::Out.WriteLine(($object | ConvertTo-Json -Compress -Depth 4))
    [Console]::Out.Flush()
}

Write-Json @{ ok = $true; ready = $true }

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line -eq '') { continue }

    $parts = $line.Split(@(' '), 2, [StringSplitOptions]::None)
    try {
        switch ($parts[0]) {
            'LIST' {
                $codeProcesses = @{}
                foreach ($p in (Get-Process -Name 'Code', 'Code - Insiders' -ErrorAction SilentlyContinue)) {
                    $codeProcesses[$p.Id] = $p.ProcessName
                }
                $windows = @()
                foreach ($w in [SdWin]::List()) {
                    $processId = [int]$w[1]
                    if (-not $codeProcesses.ContainsKey($processId)) { continue }
                    $windows += [pscustomobject]@{
                        h   = [int64]$w[0]
                        pid = $processId
                        app = $codeProcesses[$processId]
                        t   = [string]$w[2]
                    }
                }
                Write-Json @{ ok = $true; windows = @($windows) }
            }
            'FOCUS' {
                $ok = [SdWin]::Focus([int64]$parts[1])
                Write-Json @{ ok = [bool]$ok }
            }
            'PING' { Write-Json @{ ok = $true } }
            default { Write-Json @{ ok = $false; error = 'unknown command' } }
        }
    } catch {
        Write-Json @{ ok = $false; error = $_.Exception.Message }
    }
}
