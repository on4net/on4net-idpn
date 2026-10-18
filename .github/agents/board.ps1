<#
.SYNOPSIS
  Compact board helper for on4net IDPN (GitHub Project 2).

.DESCRIPTION
  Avoids dumping the full project JSON into the agent context. Every command prints
  one line per card:  #<issue>  <phase> <priority> <size>  <title>

.EXAMPLES
  pwsh -File .github/agents/board.ps1 counts
  pwsh -File .github/agents/board.ps1 ready
  pwsh -File .github/agents/board.ps1 fill 5
  pwsh -File .github/agents/board.ps1 claim 8
  pwsh -File .github/agents/board.ps1 review 8
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('counts', 'ready', 'backlog', 'inprogress', 'fill', 'claim', 'review', 'set')]
    [string]$Command,

    [Parameter(Position = 1)]
    [int]$Issue = 0,

    [Parameter(Position = 2)]
    [int]$Count = 5,

    [Parameter()]
    [ValidateSet('Backlog', 'Ready', 'In progress', 'In review', 'Done')]
    [string]$Status
)

$ErrorActionPreference = 'Stop'

$Owner = 'on4net'
$ProjectNumber = '2'
$Repo = 'on4net/on4net-idpn'
$ProjectId = 'PVT_kwDOEVue5c4Bnjku'
$StatusFieldId = 'PVTSSF_lADOEVue5c4BnjkuzhmHotg'
$StatusOptions = @{
    'Backlog'     = 'f75ad846'
    'Ready'       = '08afe404'
    'In progress' = '47fc9ee4'
    'In review'   = '4cc61d42'
    'Done'        = '98236657'
}

function Get-ProjectItems {
    $json = gh project item-list $ProjectNumber --owner $Owner --format json --limit 200
    if ($LASTEXITCODE -ne 0) { throw "gh project item-list failed" }
    $data = $json | ConvertFrom-Json
    foreach ($item in $data.items) {
        $labels = @($item.labels)
        $phase = ($labels | Where-Object { $_ -like 'phase:*' } | Select-Object -First 1)
        $priority = ($labels | Where-Object { $_ -match '^P[0-3]$' } | Select-Object -First 1)
        if (-not $priority) { $priority = 'P9' }
        $number = 0
        if ($item.content -and $item.content.number) { $number = [int]$item.content.number }
        [pscustomobject]@{
            Number   = $number
            Title    = if ($item.content) { $item.content.title } else { $item.title }
            Url      = if ($item.content) { $item.content.url } else { $null }
            Status   = $item.status
            Size     = $item.size
            Phase    = if ($phase) { $phase } else { 'phase:9' }
            Priority = $priority
            IsEpic   = ($labels -contains 'epic')
            ItemId   = $item.id
        }
    }
}

function Sort-Cards($cards) {
    $cards | Sort-Object @{ Expression = { [int]($_.Phase -replace 'phase:', '') } },
                          @{ Expression = { [int]($_.Priority -replace 'P', '') } },
                          @{ Expression = { $_.Number } }
}

function Format-Cards($cards) {
    foreach ($c in $cards) {
        '{0,-5} {1,-8} {2,-2} {3,-2} {4}' -f "#$($c.Number)", $c.Phase, $c.Priority, $c.Size, $c.Title
    }
}

function Set-Status($item, $target) {
    gh project item-edit --project-id $ProjectId --id $item.ItemId `
        --field-id $StatusFieldId --single-select-option-id $StatusOptions[$target] | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to move #$($item.Number) to $target" }
}

function Find-Card($cards, [int]$number) {
    $card = $cards | Where-Object { $_.Number -eq $number } | Select-Object -First 1
    if (-not $card) { throw "Issue #$number is not on project $ProjectNumber" }
    return $card
}

$items = Get-ProjectItems

switch ($Command) {
    'counts' {
        $items | Group-Object Status | Sort-Object Name | ForEach-Object { '{0,-12} {1}' -f $_.Name, $_.Count }
    }
    'ready' {
        $ready = Sort-Cards ($items | Where-Object { $_.Status -eq 'Ready' -and -not $_.IsEpic })
        if (-not $ready) { 'Ready is EMPTY' } else { Format-Cards $ready }
    }
    'backlog' {
        $backlog = Sort-Cards ($items | Where-Object { $_.Status -eq 'Backlog' -and -not $_.IsEpic })
        if (-not $backlog) { 'Backlog is EMPTY' } else { Format-Cards ($backlog | Select-Object -First ([Math]::Max($Count, 10))) }
    }
    'inprogress' {
        $active = Sort-Cards ($items | Where-Object { $_.Status -eq 'In progress' -and -not $_.IsEpic })
        if (-not $active) { 'In progress is EMPTY' } else { Format-Cards $active }
    }
    'fill' {
        $backlog = Sort-Cards ($items | Where-Object { $_.Status -eq 'Backlog' -and -not $_.IsEpic } | Select-Object -First $Count)
        if (-not $backlog) { 'Backlog is EMPTY'; break }
        foreach ($card in $backlog) {
            Set-Status $card 'Ready'
            'moved #' + $card.Number + ' Backlog -> Ready'
        }
    }
    'claim' {
        if ($Issue -le 0) { throw 'claim requires an issue number: board.ps1 claim <issue>' }
        $card = Find-Card $items $Issue
        if ($card.IsEpic) { throw "#$Issue is an Epic; claim its child tasks instead" }
        if ($card.Status -eq 'In progress') { "#$Issue already In progress"; break }
        if ($card.Status -in @('In review', 'Done')) { throw "#$Issue is already $($card.Status)" }
        Set-Status $card 'In progress'
        "#$Issue Backlog/Ready -> In progress"
    }
    'review' {
        if ($Issue -le 0) { throw 'review requires an issue number: board.ps1 review <issue>' }
        $card = Find-Card $items $Issue
        if ($card.Status -eq 'Done') { throw "#$Issue is already Done" }
        Set-Status $card 'In review'
        "#$Issue -> In review (Done is the owner gate, never set it here)"
    }
    'set' {
        if ($Issue -le 0) { throw 'set requires an issue number: board.ps1 set <issue> -Status <status>' }
        if (-not $Status) { throw 'set requires -Status' }
        $card = Find-Card $items $Issue
        Set-Status $card $Status
        "#$Issue -> $Status"
    }
}
