# User-scoped Task Scheduler adapter. No credentials, elevation, or arbitrary shell evaluation.
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('identity', 'inspect', 'install', 'enable', 'disable', 'start', 'uninstall')]
    [string]$Operation,
    [string]$Payload
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

try {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $sid = $identity.User.Value
    if ($Operation -eq 'identity') {
        @{ sid = $sid } | ConvertTo-Json -Compress
        exit 0
    }
    $request = Get-Content -LiteralPath $Payload -Raw -Encoding UTF8 | ConvertFrom-Json
    $c = $request.config
    if ($c.app -ne 'herdr-devtunnel' -or $c.schema -ne 1 -or $c.sid -ne $sid) {
        throw 'Configuration is not owned by the current Windows user.'
    }
    if ($c.name -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$' -or
        $c.taskName -cne ('HerdrDevTunnel-' + $sid + '-' + $c.name) -or
        $c.marker -cne ('herdr-devtunnel/autostart/v1:' + $sid + ':' + $c.name)) {
        throw 'Invalid managed task identity.'
    }
    Import-Module ScheduledTasks -ErrorAction Stop
    # Enumerate instead of suppressing AccessDenied and then overwriting a task.
    $matches = @(Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object { $_.TaskName -ceq $c.taskName })
    $task = $null
    if ($matches.Count -gt 1) { throw 'Ambiguous task identity.' }
    if ($matches.Count -eq 1) { $task = $matches[0] }
    if ($null -ne $task) {
        $expected = $c
        if ($Operation -eq 'install') {
            if ($null -eq $request.previous) { throw 'Task exists without a matching saved configuration; refusing to adopt it.' }
            $expected = $request.previous
        }
        $principalSid = $task.Principal.UserId
        if ($principalSid -notmatch '^S-1-') {
            # Avoid a fresh domain-controller lookup on disconnected AD machines.
            if ($principalSid -ine $identity.Name) { throw 'Task principal is not the current user.' }
            $principalSid = $sid
        }
        $actions = @($task.Actions)
        if ($task.Description -cne $c.marker -or $principalSid -ne $sid -or
            [string]$task.Principal.LogonType -ne 'Interactive' -or
            [string]$task.Principal.RunLevel -ne 'Limited' -or $actions.Count -ne 1 -or
            $actions[0].Execute -ine $expected.node -or $actions[0].Arguments -cne $expected.actionArguments -or
            $actions[0].WorkingDirectory -ine $expected.root) {
            throw 'Existing task does not match this installation. No task was changed.'
        }
    }
    if ($Operation -eq 'install') {
        if ($null -ne $task -and [string]$task.State -in @('Running', 'Queued')) {
            throw 'Stop the managed task before replacing its configuration.'
        }
        $action = New-ScheduledTaskAction -Execute $c.node -Argument $c.actionArguments -WorkingDirectory $c.root
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $sid
        $trigger.Delay = 'PT15S'
        $principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
            -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
            -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
        # Register disabled, publish config from Node, then explicitly enable it.
        $settings.Enabled = $false
        $definition = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $c.marker
        if ($null -eq $task) {
            Register-ScheduledTask -TaskName $c.taskName -TaskPath '\' -InputObject $definition | Out-Null
        } else {
            Register-ScheduledTask -TaskName $c.taskName -TaskPath '\' -InputObject $definition -Force | Out-Null
        }
    } elseif ($Operation -in @('enable', 'disable', 'start', 'uninstall')) {
        if ($null -eq $task) { throw 'Managed task is not registered. Run autostart install first.' }
        switch ($Operation) {
            'enable' { Enable-ScheduledTask -TaskName $c.taskName -TaskPath '\' | Out-Null }
            'disable' { Disable-ScheduledTask -TaskName $c.taskName -TaskPath '\' | Out-Null }
            'start' { Start-ScheduledTask -TaskName $c.taskName -TaskPath '\' }
            'uninstall' {
                if ([string]$task.State -in @('Running', 'Queued')) { throw 'Refusing to unregister a running/queued task; stop it gracefully first.' }
                Unregister-ScheduledTask -TaskName $c.taskName -TaskPath '\' -Confirm:$false
            }
        }
    }
    $task = @(Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object { $_.TaskName -ceq $c.taskName })
    if ($task.Count -eq 0) {
        @{ exists = $false; taskName = $c.taskName } | ConvertTo-Json -Compress
    } else {
        $task = $task[0]
        $info = Get-ScheduledTaskInfo -TaskName $c.taskName -TaskPath '\'
        @{
            exists = $true; taskName = $c.taskName; state = [string]$task.State
            enabled = [bool]$task.Settings.Enabled; lastResult = $info.LastTaskResult
            lastRun = $info.LastRunTime.ToString('o'); logonType = [string]$task.Principal.LogonType
            runLevel = [string]$task.Principal.RunLevel; executionTimeLimit = $task.Settings.ExecutionTimeLimit
            restartCount = $task.Settings.RestartCount; restartInterval = $task.Settings.RestartInterval
            multipleInstances = [string]$task.Settings.MultipleInstances
        } | ConvertTo-Json -Compress
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
