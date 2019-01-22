import { isPlatformBrowser } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ContentChild,
  ContentChildren,
  ElementRef,
  forwardRef,
  Inject,
  Input,
  NgZone,
  OnDestroy,
  PLATFORM_ID,
  QueryList,
  Renderer2,
  TemplateRef,
  ViewChild,
  ViewContainerRef,
  EmbeddedViewRef,
} from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { BehaviorSubject, forkJoin, fromEvent, interval, merge, Observable, of, Subject, Subscription, timer } from 'rxjs';
import { bufferCount, switchMap, takeUntil, tap, filter } from 'rxjs/operators';

import { NgxHmCarouselItemDirective } from './ngx-hm-carousel-item.directive';
import { resizeObservable } from './rxjs.observable.resize';
import { NgxHmCarouselBreakPointUp } from './ngx-hm-carousel.model';
import { DOCUMENT } from '@angular/common';

// if the pane is paned .15, switch to the next pane.
const PANBOUNDARY = 0.15;

@Component({
  selector: 'ngx-hm-carousel',
  templateUrl: './ngx-hm-carousel.component.html',
  styleUrls: ['./ngx-hm-carousel.component.scss'],
  providers: [{
    provide: NG_VALUE_ACCESSOR,
    useExisting: forwardRef(() => NgxHmCarouselComponent),
    multi: true
  }],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class NgxHmCarouselComponent implements ControlValueAccessor, AfterViewInit, OnDestroy {
  @ViewChild('containerElm') container: ElementRef;
  @ViewChild('prev') btnPrev: ElementRef;
  @ViewChild('next') btnNext: ElementRef;
  @ViewChild('progress') progressContainerElm: ElementRef;
  // get all item elms
  @ContentChildren(NgxHmCarouselItemDirective, { read: ElementRef }) itemElms: QueryList<ElementRef>;
  @ContentChild('carouselPrev') contentPrev: TemplateRef<any>;
  @ContentChild('carouselNext') contentNext: TemplateRef<any>;
  @ContentChild('carouselDot') dotElm: TemplateRef<any>;
  @ContentChild('carouselProgress') progressElm: TemplateRef<any>;

  @ContentChild('infiniteContainer', { read: ViewContainerRef }) infiniteContainer: ViewContainerRef;
  @ContentChild('carouselContent') contentContent: TemplateRef<any>;

  @Input() data: any[];
  @Input() aniTime = 400;
  @Input() aniClass = 'transition';
  @Input() aniClassAuto = this.aniClass;

  // this default autoplay animation is same as aniClass
  @Input() align: 'left' | 'center' | 'right' = 'center';
  @Input('not-follow-pan') notDrag = false;
  @Input('mourse-enable') mourseEnable = false;
  @Input('between-delay') delay = 8000;
  @Input('autoplay-direction') direction: 'left' | 'right' = 'right';
  @Input('scroll-num') scrollNum = 1;
  @Input('drag-many') isDragMany = false;

  @Input() breakpoint: NgxHmCarouselBreakPointUp[] = [];

  @Input('disable-drag')
  get disableDrag() {
    return this._disableDrag;
  }
  set disableDrag(value) {
    if (this.rootElm) {
      if (this._disableDrag !== value) {
        if (value) {
          this.destoryHammer();
        } else {
          this.hammer = this.bindHammer();
        }
      }
    }
    this._disableDrag = value;
  }

  @Input('infinite')
  get infinite() { return this._infinite; }
  set infinite(value) {
    this._infinite = value;

    this.infiniteElmRefs.forEach((ref) => {
      this.addStyle(ref.rootNodes[0], {
        visibility: this.runLoop ? 'visible' : 'hidden'
      });
    });
  }

  @Input('autoplay-speed')
  get speed() { return this.speedChange.value; }
  set speed(value) {
    this._zone.runOutsideAngular(() => {
      this.speedChange.next(value);
    });
  }

  @Input('show-num')
  get showNum() { return this._showNum; }
  set showNum(value: number | 'auto') {
    if (value === 'auto') {
      this.isAutoNum = true;
    } else {
      this._showNum = +value;
      if (this.rootElm) {
        this.setViewWidth();
        this.reSetAlignDistance();
      }
    }
  }

  @Input('autoplay')
  get autoplay() { return this._autoplay; }
  set autoplay(value) {
    if (isPlatformBrowser(this.platformId)) {
      if (this.elms) {
        this.progressWidth = 0;
        if (value) {
          this._zone.runOutsideAngular(() => {
            this.doNextSub$ = this.doNext.subscribe();
          });
        } else {
          if (this.doNextSub$) { this.doNextSub$.unsubscribe(); }
        }
      }
    }
    this._autoplay = value;
    // if set autoplay, then the infinite is true
    if (value) {
      this._tmpInfinite = this.infinite;
      this.infinite = true;
    } else {
      this.infinite = this._tmpInfinite;
    }
  }

  get currentIndex() { return this._currentIndex; }
  set currentIndex(value) {
    // if now index if not equale to save index, do someting
    if (this.currentIndex !== value) {

      // if the value is not contain with the boundary not handler
      if (!this.runLoop && !(0 <= value && value <= this.itemElms.length - 1)) {
        return;
      }
      this._currentIndex = value;
      if (this.elms) {
        if (this.autoplay && !this.isFromAuto) {

          this._zone.runOutsideAngular(() => {
            this.stopEvent.next();
            this.callRestart();
          });
        }
        this.drawView(this.currentIndex, this.hasInitWriteValue);
        if (this.isDragMany) {
          this.hasInitWriteValue = true;
        }
      }
      if (0 <= this.currentIndex && this.currentIndex <= this.itemElms.length - 1) {
        this._zone.run(() => {
          this.onChange(this.currentIndex);
          this._cd.detectChanges();
        });
      }
    }
    this.isFromAuto = false;
  }

  get progressWidth() { return this._porgressWidth; }
  set progressWidth(value) {
    if (this.progressElm !== undefined && this.autoplay) {
      this._porgressWidth = value;
      this._renderer.setStyle(
        (<HTMLElement>this.progressContainerElm.nativeElement).children[0],
        'width',
        `${this.progressWidth}%`
      );
    }
  }

  get grabbing() { return this._grabbing; }
  set grabbing(value: boolean) {
    if (this._grabbing !== value) {
      // console.log(value);
      this._zone.run(() => {
        if (value) {
          this._renderer.addClass(this.containerElm, 'grabbing');
        } else {
          this.panCount = 0;
          this.callRestart();
          this._renderer.removeClass(this.containerElm, 'grabbing');
        }
        this._grabbing = value;
        this._cd.detectChanges();
      });
    }
  }

  // using for check mouse or touchend
  leaveObs$ = merge(
    fromEvent(this._document, 'mouseup'),
    fromEvent(this._document, 'touchend')
  ).pipe(
    tap((e: Event) => {
      this.grabbing = false;
      e.stopPropagation();
      e.preventDefault();
    })
  );

  private set left(value: number) {

    if (isPlatformBrowser(this.platformId)) {
      this._renderer.setStyle(this.containerElm, 'transform', `translateX(${value}px)`);
    } else {
      this._renderer.setStyle(this.containerElm, 'transform', `translateX(${value}%)`);
    }
  }

  private get maxRightIndex() {
    let addIndex = 0;
    switch (this.align) {
      case 'left':
        addIndex = 0;
        break;
      case 'center':
        addIndex = <number>this.showNum - 1;
        break;
      case 'right':
        addIndex = <number>this.showNum - 1;
        break;
    }
    return ((this.itemElms.length - 1) - this._showNum + 1) + addIndex;
  }

  private get runLoop() { return this.autoplay || this.infinite; }
  private get lengthOne() { return this.itemElms.length === 1; }

  private get rootElmWidth() {
    return (isPlatformBrowser(this.platformId) ? this.rootElm.getBoundingClientRect().width : 100);
  }

  private set containerElmWidth(value) {
    this.setStyle(this.containerElm, 'width', value);
  }

  private isFromAuto = true;
  private isAutoNum = false;
  private mouseOnContainer = false;
  private alignDistance = 0;
  private elmWidth = 0;

  private rootElm: HTMLElement;
  private containerElm: HTMLElement;

  private elms: Array<HTMLElement>;
  private infiniteElmRefs: Array<EmbeddedViewRef<any>> = [];

  private hammer: HammerManager;

  private saveTimeOut: Subscription;
  private doNextSub$: Subscription;
  private doNext: Observable<any>;

  private restart = new BehaviorSubject<any>(null);
  private speedChange = new BehaviorSubject(5000);
  private stopEvent = new Subject<any>();
  private destroy$ = new Subject<any>();

  private _porgressWidth = 0;
  private _currentIndex = 0;
  private _showNum = 1;
  private _autoplay = false;
  private _infinite = false;
  private _tmpInfinite = false;
  private _grabbing = false;

  private panCount = 0;

  private _disableDrag = false;

  // this variable use for check the init value is write with ngModel,
  // when init first, not set with animation
  private hasInitWriteValue = false;

  constructor(
    @Inject(PLATFORM_ID) private platformId: Object,
    @Inject(DOCUMENT) private _document,
    private _renderer: Renderer2,
    private _zone: NgZone,
    private _cd: ChangeDetectorRef
  ) { }

  ngAfterViewInit() {
    this.rootElm = this.container.nativeElement;
    this.containerElm = this.rootElm.children[0] as HTMLElement;

    this.init();

    forkJoin(
      this.bindClick(),
      // when item changed, remove old hammer binding, and reset width
      this.itemElms.changes.pipe(
        // detectChanges to change view dots
        tap(() => {
          if (this.currentIndex > this.itemElms.length - 1) {
            // i can't pass the changedetection check, only the way to using timeout. :(
            setTimeout(() => {
              this.currentIndex = this.itemElms.length - 1;
            }, 0);
          }
          this.destroy();
          this.removeInfiniteElm();
          this.init();
          this.progressWidth = 0;
        }),
        tap(() => this._cd.detectChanges()),
      ),
      resizeObservable(
        this.rootElm, () => this.containerResize()
      )
    ).pipe(
      takeUntil(this.destroy$),
    ).subscribe();

  }

  ngOnDestroy() {
    this.destroy();
    this.destroy$.next();
    this.destroy$.unsubscribe();
  }
  writeValue(value: any) {
    if (value || value === 0) {
      this.currentIndex = value;
      this.hasInitWriteValue = true;
    }
  }
  registerOnChange(fn: (value: any) => any) { this.onChange = fn; }
  registerOnTouched(fn: () => any) { this.onTouched = fn; }
  private onChange = (_: any) => { };
  private onTouched = () => { };

  private init() {
    this.initVariable();
    this.setViewWidth(true);
    this.reSetAlignDistance();
    if (!this.disableDrag) {
      this.hammer = this.bindHammer();
    }
    this.drawView(this.currentIndex, false);
    if (isPlatformBrowser(this.platformId) && this.runLoop) {
      this.addInfiniteElm();
    }
  }

  private destroy() {
    this.destoryHammer();

    if (this.autoplay) { this.doNextSub$.unsubscribe(); }
  }

  private destoryHammer() {
    if (this.hammer) {
      this.hammer.destroy();
    }
  }

  private addInfiniteElm() {
    for (let i = 1; i <= this.showNum; i++) {
      const elm = this.infiniteContainer.createEmbeddedView(this.contentContent, {
        $implicit: this.data[this.itemElms.length - i],
        index: this.itemElms.length - i
      });
      this.addStyle(elm.rootNodes[0], {
        position: 'absolute',
        transform: `translateX(-${100 * i}%)`,
        visibility: this.runLoop ? 'visible' : 'hidden'
      });
      this.setStyle(elm.rootNodes[0], 'width', this.elmWidth);

      const elm2 = this.infiniteContainer.createEmbeddedView(this.contentContent, {
        $implicit: this.data[i - 1],
        index: i - 1
      });
      this.addStyle(elm2.rootNodes[0], {
        position: 'absolute',
        right: 0,
        top: 0,
        transform: `translateX(${100 * i}%)`,
        visibility: this.runLoop ? 'visible' : 'hidden'
      });
      this.setStyle(elm2.rootNodes[0], 'width', this.elmWidth);

      elm.detectChanges();
      elm2.detectChanges();

      this.infiniteElmRefs.push(elm);
      this.infiniteElmRefs.push(elm2);
    }

  }

  private removeInfiniteElm() {
    this.infiniteElmRefs.forEach(a => {
      a.detach();
      a.destroy();
    });
    this.infiniteContainer.clear();
    this.infiniteElmRefs = [];
  }

  private containerResize() {
    this.setViewWidth();
    this.reSetAlignDistance();

    // 因為不能滑了，所以要回到第一個，以確保全部都有顯示
    if (this.align !== 'center' && this.showNum >= this.elms.length) {
      this.currentIndex = 0;
    }
    this.drawView(this.currentIndex, false);
  }

  private initVariable() {
    this._zone.runOutsideAngular(() => {

      this.elms = this.itemElms.toArray().map(x => x.nativeElement);

      let startEvent = this.restart.asObservable();
      let stopEvent = this.stopEvent.asObservable();
      if (this.mourseEnable) {
        startEvent = merge(
          startEvent,
          fromEvent(this.containerElm, 'mouseleave').pipe(
            // when leave, we should reverse grabbing state to set the mouseOn state,
            // because when the grabbing, the mask will on, and it will occur leave again
            filter(() => !this.grabbing),
            tap(() => this.mouseOnContainer = false)
          )
        );
        stopEvent = merge(
          stopEvent,
          fromEvent(this.containerElm, 'mouseover').pipe(
            tap(() => this.mouseOnContainer = true)
          )
        );
      }

      this.doNext = startEvent.pipe(
        // not using debounceTime, it will stop mourseover event detect, will cause mourse-enable error
        // debounceTime(this.delay),
        switchMap(() => this.speedChange),
        switchMap(() =>
          timer(this.delay).pipe(
            switchMap(() => this.runProgress(20)),
            tap(() => {
              this.isFromAuto = true;
              // console.log('next');
              if (this.direction === 'left') {
                this.currentIndex -= this.scrollNum;
              } else {
                this.currentIndex += this.scrollNum;
              }
            }),
            takeUntil(stopEvent.pipe(
              tap(() => this.progressWidth = 0)
            ))
          )
        ));

      if (this.autoplay) {
        this.doNextSub$ = this.doNext.subscribe();
      }
    });
  }

  private reSetAlignDistance() {
    switch (this.align) {
      case 'center':
        this.alignDistance = (this.rootElmWidth - this.elmWidth) / 2;
        break;
      case 'left':
        this.alignDistance = 0;
        break;
      case 'right':
        this.alignDistance = this.rootElmWidth - this.elmWidth;
        break;
    }
  }

  private setViewWidth(isInit?: boolean) {
    if (this.isAutoNum) {
      this._showNum = this.getAutoNum();
    }
    this._renderer.addClass(this.containerElm, 'grab');
    if (isInit) {
      // remain one elm height
      this._renderer.addClass(this.containerElm, 'ngx-hm-carousel-display-npwrap');
    }
    this.elmWidth = this.rootElmWidth / this._showNum;

    this._renderer.removeClass(this.containerElm, 'ngx-hm-carousel-display-npwrap');

    this.containerElmWidth = this.elmWidth * this.elms.length;

    this._renderer.setStyle(this.containerElm, 'position', 'relative');

    this.infiniteElmRefs.forEach((ref) => {
      this.setStyle(ref.rootNodes[0], 'width', this.elmWidth);
    });
    this.elms.forEach((elm: HTMLElement) => {
      this.setStyle(elm, 'width', this.elmWidth);
    });

  }

  private bindHammer() {
    if (!isPlatformBrowser(this.platformId)) {
      return null;
    }
    return this._zone.runOutsideAngular(() => {

      const hm = new Hammer(this.containerElm);
      hm.get('pan').set({ direction: Hammer.DIRECTION_HORIZONTAL });

      hm.on('panleft panright panend pancancel', (e: HammerInput) => {
        // console.log(e.type);

        if (this.lengthOne) {
          return;
        }

        this.removeContainerTransition();

        if (this.autoplay) {
          this._zone.runOutsideAngular(() => { this.stopEvent.next(); });
        }

        switch (e.type) {
          case 'panleft':
          case 'panright':
            this.panCount++;
            // only when panmove more than two times, set move
            if (this.panCount < 2) {
              return;
            }

            this.grabbing = true;
            // When show-num is bigger than length, stop hammer
            if (this.align !== 'center' && this.showNum >= this.elms.length) {
              this.hammer.stop(true);
              return;
            }
            // Slow down at the first and last pane.
            if (!this.runLoop && this.outOfBound(e.type)) {
              e.deltaX *= 0.2;
            }

            if (!this.notDrag) {
              this.left = -this.currentIndex * this.elmWidth + this.alignDistance + e.deltaX;
            }

            // // if not dragmany, when bigger than half
            if (!this.isDragMany) {
              if (Math.abs(e.deltaX) > this.elmWidth * 0.5) {
                if (e.deltaX > 0) {
                  this.currentIndex -= this.scrollNum;
                } else {
                  this.currentIndex += this.scrollNum;
                }
                this.hammer.stop(true);
                return;
              }
            }
            break;
          case 'pancancel':
            this.drawView(this.currentIndex);
            break;

          case 'panend':

            if (Math.abs(e.deltaX) > this.elmWidth * PANBOUNDARY) {
              const moveNum = this.isDragMany ?
                Math.ceil(Math.abs(e.deltaX) / this.elmWidth) : this.scrollNum;

              let prevIndex = this.currentIndex - moveNum;
              let nextIndex = this.currentIndex + moveNum;

              // if right
              if (e.deltaX > 0) {
                if (!this.runLoop && prevIndex < 0) {
                  prevIndex = 0;
                  this.drawView(0);
                }

                this.currentIndex = prevIndex;
                // left
              } else {
                if (!this.runLoop && nextIndex > this.maxRightIndex) {
                  nextIndex = this.maxRightIndex;
                  this.drawView(nextIndex);
                }
                this.currentIndex = nextIndex;
              }
              break;
            }
            this.drawView(this.currentIndex);
            break;
        }
      });

      return hm;
    });

  }

  private bindClick() {
    if (this.btnNext && this.btnPrev) {
      return forkJoin(
        fromEvent(this.btnNext.nativeElement, 'click').pipe(
          tap(() => this.currentIndex++)
        ),
        fromEvent(this.btnPrev.nativeElement, 'click').pipe(
          tap(() => this.currentIndex--)
        )
      );
    }
    return of(null);
  }

  private callRestart() {
    // if that is autoplay
    // if that mouse is not on container( only mouse-enable is true, the state maybe true)
    // if now is grabbing, skip this restart, using grabbing change restart
    if (this.autoplay && !this.mouseOnContainer && !this.grabbing) {
      this._zone.runOutsideAngular(() => {
        this.restart.next(null);
      });
    }
  }

  private drawView(index: number, isAnimation = true, isFromAuto = this.isFromAuto) {

    // move element only on length is more than 1
    if (this.elms.length > 1) {
      this.removeContainerTransition();
      this.left = -((index * this.elmWidth) - this.alignDistance);

      if (isAnimation) {
        if (isFromAuto) {
          this._renderer.addClass(this.containerElm, this.aniClassAuto);
        } else {
          this._renderer.addClass(this.containerElm, this.aniClass);
        }
        // if infinite move to next index with timeout
        this.infiniteHandler(index);
      }

    } else {
      this.left = this.alignDistance;
    }
  }

  private removeContainerTransition() {
    this._renderer.removeClass(this.containerElm, this.aniClass);
    this._renderer.removeClass(this.containerElm, this.aniClassAuto);
  }

  private infiniteHandler(index: number) {
    if (this.runLoop) {
      let state = 0;
      state = (index < 0) ? -1 : state;
      state = (index > (this.itemElms.length - 1)) ? 1 : state;
      if (state !== 0) {
        switch (state) {
          case -1:
            this._currentIndex = (this.itemElms.length + index);
            break;
          case 1:
            this._currentIndex = index % this._showNum - 1;
            break;
        }

        const isFromAuto = this.isFromAuto;
        if (this.saveTimeOut) {
          this.saveTimeOut.unsubscribe();
        }

        if (isFromAuto) {
          this.saveTimeOut = timer(this.aniTime).pipe(
            switchMap(() => {
              this.removeContainerTransition();

              this.left = -(this._currentIndex * this.elmWidth) + this.alignDistance;

              // if it is any loop carousel, the next event need wait the timeout complete
              if (this.aniTime === this.speed) {
                this.left = -((this._currentIndex + (this.direction === 'right' ? -1 : 1)) * this.elmWidth) + this.alignDistance;
                return timer(50).pipe(
                  tap(() => {
                    this.drawView(this.currentIndex, this.hasInitWriteValue, isFromAuto);
                  })
                );
              }
              return of(null);
            }),
            takeUntil(this.stopEvent)
          ).subscribe();
        }
      }
    }
  }

  private outOfBound(type) {
    switch (type) {
      case 'panleft':
        return this.currentIndex >= this.maxRightIndex;
      case 'panright':
        return this.currentIndex <= 0;
    }
  }

  private runProgress(betweenTime): Observable<any> {

    return this._zone.runOutsideAngular(() => {
      const howTimes = this.speed / betweenTime;
      const everyIncrease = 100 / this.speed * betweenTime;
      return interval(betweenTime).pipe(
        tap(t => {
          this.progressWidth = (t % howTimes) * everyIncrease;
        }),
        bufferCount(Math.round(howTimes), 0)
      );
    });
  }

  private getAutoNum() {
    const curr_width = this.rootElmWidth;
    // check user has had set breakpoint
    if (this.breakpoint.length > 0) {
      // get the last bigget point
      const now = this.breakpoint.find((b) => {
        return b.width >= curr_width;
      });
      // if find value, it is current width
      if (now) {
        return now.number;
      }
      return this.breakpoint[this.breakpoint.length - 1].number;
    }

    // system init show number
    const initNum = 3;
    // 610
    if (curr_width > 300) {
      return Math.floor(initNum + (curr_width / 200));
    }
    return initNum;
  }

  private addStyle(elm: HTMLElement, style: { [key: string]: string | number }) {
    if (style) {
      Object.keys(style).forEach((key) => {
        const value = style[key];
        this._renderer.setStyle(elm, key, value);
      });
    }
  }

  private setStyle(elm: HTMLElement, style: string, value: number) {
    if (isPlatformBrowser(this.platformId)) {
      this._renderer.setStyle(elm, style, `${value}px`);
    } else {
      this._renderer.setStyle(elm, style, `${value}%`);
    }
  }

}

