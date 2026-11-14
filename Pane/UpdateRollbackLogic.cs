namespace Pane;

/// <summary>
/// 更新の入れ替えが途中で失敗したとき、何を消して何を戻すかの判断。
///
/// 以前は、失敗したら無条件に「今のexe」と「今のdist」を消してから、退避したものを戻していた。
/// 最初の一歩(今のexeを退避する)で失敗した場合や、distの退避で失敗した場合は、まだ何も
/// 置き換えていないので、「今のdist」は手つかずの正しいものである。それを消してしまい、
/// 退避もしていないので戻すものも無く、画面を描くファイルの無いPaneが残った(2026-11 の点検)。
/// 消してよいのは、新しいものを置き始めたあとの、置きかけのものだけ。
///
/// ファイルに触れない判定だけをここへ切り出し、Pane.Tests側で固定する。
/// </summary>
internal static class UpdateRollbackLogic
{
    /// <summary>元に戻すときにやること。</summary>
    /// <param name="DeleteCurrentExe">今の場所にあるexe(置きかけの新しいもの)を消す。</param>
    /// <param name="DeleteCurrentDist">今の場所にあるdist(置きかけの新しいもの)を消す。</param>
    /// <param name="RestoreExe">退避したexeを戻す。</param>
    /// <param name="RestoreDist">退避したdistを戻す。</param>
    internal readonly record struct Plan(bool DeleteCurrentExe, bool DeleteCurrentDist, bool RestoreExe, bool RestoreDist);

    /// <param name="exeMoved">今のexeを退避し終えたか。</param>
    /// <param name="distMoved">今のdistを退避し終えたか。</param>
    /// <param name="newExeStarted">新しいexeを置き始めたか。</param>
    /// <param name="newDistStarted">新しいdistを置き始めたか。</param>
    internal static Plan Decide(bool exeMoved, bool distMoved, bool newExeStarted, bool newDistStarted)
        => new(
            DeleteCurrentExe: newExeStarted,
            DeleteCurrentDist: newDistStarted,
            RestoreExe: exeMoved,
            RestoreDist: distMoved);
}
